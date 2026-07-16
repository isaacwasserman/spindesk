/**
 * End-to-end tests for the service-desk stack.
 *
 * Each test gets a fresh in-memory SQLite via createApp(), exercising the full
 * better-auth → futonic → service-desk → SQLite path. Authenticated headers are
 * minted with the better-auth `testUtils` plugin — no manual sign-in flow.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { IMPERSONATION_HEADER, type TicketMetadataSchema } from "@spindesk/core";
import { type App, type CreateAppOptions, createApp } from "./host/server";

// Fixed ids so we can seed the agent predicate before the users exist.
const AGENT_ID = "agent-1";
const USER_ID = "user-1";
const OTHER_ID = "user-2";
const MOUNT = "/api/servicedesk";

interface Fixture {
	app: App;
	headers: Record<string, Headers>; // by user id
}

const TAGS = ["billing", "bug", "urgent"];

async function setup(opts: Partial<CreateAppOptions> = {}): Promise<Fixture> {
	const app = await createApp({
		userIsAgent: (user) => user.id === AGENT_ID,
		availableTags: TAGS,
		...opts,
	});
	// biome-ignore lint/suspicious/noExplicitAny: test helpers are dynamic
	const t = (await (app.auth as any).$context).test;

	const headers: Record<string, Headers> = {};
	for (const [id, email] of [
		[AGENT_ID, "agent@example.com"],
		[USER_ID, "user@example.com"],
		[OTHER_ID, "other@example.com"],
	] as const) {
		const saved = await t.saveUser(
			t.createUser({ id, email, name: email }),
		);
		const authHeaders = await t.getAuthHeaders({ userId: saved.id });
		headers[saved.id] = authHeaders;
		// If the helper ignored our fixed id, remap so lookups still work.
		if (saved.id !== id) headers[id] = authHeaders;
	}
	return { app, headers };
}

function reqInit(headers?: Headers, init: RequestInit = {}): RequestInit {
	const h = new Headers(headers);
	// merge any caller-supplied headers (e.g. x-filename, content-type)
	if (init.headers) {
		new Headers(init.headers).forEach((v, k) => h.set(k, v));
	}
	if (init.body && !h.has("content-type")) {
		h.set("content-type", "application/json");
	}
	return { ...init, headers: h };
}

function call(
	app: App,
	path: string,
	headers?: Headers,
	init: RequestInit = {},
) {
	return app.fetch(
		new Request(`http://localhost${path}`, reqInit(headers, init)),
	);
}

const post = (app: App, path: string, headers: Headers | undefined, body: unknown) =>
	call(app, path, headers, { method: "POST", body: JSON.stringify(body) });
const patch = (app: App, path: string, headers: Headers | undefined, body: unknown) =>
	call(app, path, headers, { method: "PATCH", body: JSON.stringify(body) });
const del = (app: App, path: string, headers: Headers | undefined) =>
	call(app, path, headers, { method: "DELETE" });

describe("service-desk", () => {
	let app: App;
	let H: Record<string, Headers>;

	beforeEach(async () => {
		const f = await setup();
		app = f.app;
		H = f.headers;
	});

	test("rejects unauthenticated requests", async () => {
		const res = await call(app, `${MOUNT}/tickets`);
		expect(res.status).toBe(401);
	});

	test("/me reflects lazily-provisioned roles (config-seeded agent)", async () => {
		const agent = await (await call(app, `${MOUNT}/me`, H[AGENT_ID])).json() as any;
		expect(agent).toEqual({
			id: AGENT_ID,
			role: "agent",
			name: "agent@example.com",
		});

		const user = await (await call(app, `${MOUNT}/me`, H[USER_ID])).json() as any;
		expect(user).toEqual({
			id: USER_ID,
			role: "user",
			name: "user@example.com",
		});
	});

	test("userIsAgent predicate seeds by email and may be async", async () => {
		const f = await setup({
			userIsAgent: async (user) =>
				user.email === "user@example.com",
		});
		const seeded = await (
			await call(f.app, `${MOUNT}/me`, f.headers[USER_ID])
		).json() as any;
		expect(seeded.role).toBe("agent");

		const other = await (
			await call(f.app, `${MOUNT}/me`, f.headers[OTHER_ID])
		).json() as any;
		expect(other.role).toBe("user");
	});

	test("user creates a ticket and sees only their own", async () => {
		const created = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "Printer broken",
				description: "It is on fire",
			})
		).json() as any;
		expect(created.userId).toBe(USER_ID);
		expect(created.status).toBe("open");
		expect(typeof created.id).toBe("string");

		// owner sees it
		const mine = await (await call(app, `${MOUNT}/tickets`, H[USER_ID])).json() as any;
		expect(mine.total).toBe(1);
		expect(mine.tickets[0].id).toBe(created.id);

		// another user does not
		const others = await (
			await call(app, `${MOUNT}/tickets`, H[OTHER_ID])
		).json() as any;
		expect(others.total).toBe(0);

		// agent sees all
		const all = await (await call(app, `${MOUNT}/tickets`, H[AGENT_ID])).json() as any;
		expect(all.total).toBe(1);
	});

	test("other user cannot read someone else's ticket (403), agent can", async () => {
		const created = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;

		expect(
			(await call(app, `${MOUNT}/tickets/${created.id}`, H[OTHER_ID]))
				.status,
		).toBe(403);
		expect(
			(await call(app, `${MOUNT}/tickets/${created.id}`, H[AGENT_ID]))
				.status,
		).toBe(200);
	});

	test("comment thread round-trips with author roles", async () => {
		const ticket = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;

		await post(app, `${MOUNT}/tickets/${ticket.id}/comments`, H[USER_ID], {
			body: "please help",
		});
		await post(app, `${MOUNT}/tickets/${ticket.id}/comments`, H[AGENT_ID], {
			body: "on it",
		});

		const res = await call(
			app,
			`${MOUNT}/tickets/${ticket.id}/comments`,
			H[USER_ID],
		);
		const { comments, total } = await res.json() as any;
		expect(total).toBe(2);
		expect(comments.map((c: { authorRole: string }) => c.authorRole)).toEqual(
			["user", "agent"],
		);
		// live author names resolved from better-auth's user table
		expect(comments.map((c: { authorName: string }) => c.authorName)).toEqual(
			["user@example.com", "agent@example.com"],
		);

		// unrelated user cannot comment
		expect(
			(
				await post(
					app,
					`${MOUNT}/tickets/${ticket.id}/comments`,
					H[OTHER_ID],
					{ body: "nope" },
				)
			).status,
		).toBe(403);
	});

	test("comments nest via parentId (unlimited depth)", async () => {
		const ticket = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;
		const cUrl = `${MOUNT}/tickets/${ticket.id}/comments`;

		const root = await (
			await post(app, cUrl, H[USER_ID], { body: "root" })
		).json() as any;
		expect(root.parentId).toBeNull();

		const reply = await (
			await post(app, cUrl, H[AGENT_ID], {
				body: "reply",
				parentId: root.id,
			})
		).json() as any;
		expect(reply.parentId).toBe(root.id);

		const grandchild = await (
			await post(app, cUrl, H[USER_ID], {
				body: "reply to reply",
				parentId: reply.id,
			})
		).json() as any;
		expect(grandchild.parentId).toBe(reply.id);

		const { comments } = await (await call(app, cUrl, H[USER_ID])).json() as any;
		const byId = Object.fromEntries(
			comments.map((c: any) => [c.body, c.parentId]),
		);
		expect(byId).toEqual({
			root: null,
			reply: root.id,
			"reply to reply": reply.id,
		});
	});

	test("rejects a reply whose parent is on another ticket", async () => {
		const a = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "a",
				description: "d",
			})
		).json() as any;
		const b = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "b",
				description: "d",
			})
		).json() as any;
		const onA = await (
			await post(app, `${MOUNT}/tickets/${a.id}/comments`, H[USER_ID], {
				body: "on A",
			})
		).json() as any;

		// reply on ticket B pointing at a comment from ticket A → 400
		const res = await post(app, `${MOUNT}/tickets/${b.id}/comments`, H[USER_ID], {
			body: "cross",
			parentId: onA.id,
		});
		expect(res.status).toBe(400);
	});

	test("tickets and /me carry live display names", async () => {
		const ticket = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;
		expect(ticket.userName).toBe("user@example.com");

		await patch(app, `${MOUNT}/tickets/${ticket.id}`, H[AGENT_ID], {
			assigneeId: AGENT_ID,
		});
		const fetched = await (
			await call(app, `${MOUNT}/tickets/${ticket.id}`, H[AGENT_ID])
		).json() as any;
		expect(fetched.userName).toBe("user@example.com");
		expect(fetched.assigneeName).toBe("agent@example.com");

		const me = await (await call(app, `${MOUNT}/me`, H[USER_ID])).json() as any;
		expect(me).toEqual({
			id: USER_ID,
			role: "user",
			name: "user@example.com",
		});
	});

	test("agent updates status/assignee; owner limited to open/close", async () => {
		const ticket = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;

		// agent sets pending + assigns
		const updated = await (
			await patch(app, `${MOUNT}/tickets/${ticket.id}`, H[AGENT_ID], {
				status: "pending",
				assigneeId: AGENT_ID,
			})
		).json() as any;
		expect(updated.status).toBe("pending");
		expect(updated.assigneeId).toBe(AGENT_ID);

		// owner may close
		expect(
			(
				await patch(app, `${MOUNT}/tickets/${ticket.id}`, H[USER_ID], {
					status: "closed",
				})
			).status,
		).toBe(200);

		// owner may NOT set resolved
		expect(
			(
				await patch(app, `${MOUNT}/tickets/${ticket.id}`, H[USER_ID], {
					status: "resolved",
				})
			).status,
		).toBe(403);

		// owner may NOT assign
		expect(
			(
				await patch(app, `${MOUNT}/tickets/${ticket.id}`, H[USER_ID], {
					assigneeId: USER_ID,
				})
			).status,
		).toBe(403);
	});

	test("agent filters ticket list with a Lucene query", async () => {
		const a = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "a",
				description: "d",
			})
		).json() as any;
		await post(app, `${MOUNT}/tickets`, H[OTHER_ID], {
			subject: "b",
			description: "d",
		});
		await patch(app, `${MOUNT}/tickets/${a.id}`, H[AGENT_ID], {
			assigneeId: AGENT_ID,
		});

		const res = await call(
			app,
			`${MOUNT}/tickets?q=${encodeURIComponent(`assignee:${AGENT_ID}`)}`,
			H[AGENT_ID],
		);
		const { tickets, total } = await res.json() as any;
		expect(total).toBe(1);
		expect(tickets[0].id).toBe(a.id);
	});

	test("author edits and archives; others cannot", async () => {
		const t = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "orig",
				description: "d",
				tags: ["billing"],
			})
		).json() as any;
		expect(t.tags).toEqual(["billing"]);

		// author edits content + tags
		const edited = await (
			await patch(app, `${MOUNT}/tickets/${t.id}`, H[USER_ID], {
				subject: "edited",
				tags: ["bug", "urgent"],
			})
		).json() as any;
		expect(edited.subject).toBe("edited");
		expect(edited.tags.sort()).toEqual(["bug", "urgent"]);

		// a different (non-agent) user may not edit
		expect(
			(await patch(app, `${MOUNT}/tickets/${t.id}`, H[OTHER_ID], {
				subject: "hack",
			})).status,
		).toBe(403);

		// unknown tag rejected
		expect(
			(await patch(app, `${MOUNT}/tickets/${t.id}`, H[USER_ID], {
				tags: ["nope"],
			})).status,
		).toBe(400);

		// archive hides from default list, visible with archived:true
		await patch(app, `${MOUNT}/tickets/${t.id}`, H[USER_ID], { archived: true });
		const def = await (await call(app, `${MOUNT}/tickets`, H[USER_ID])).json() as any;
		expect(def.tickets.find((x: any) => x.id === t.id)).toBeUndefined();
		const arch = await (
			await call(app, `${MOUNT}/tickets?q=archived:true`, H[USER_ID])
		).json() as any;
		expect(arch.tickets.find((x: any) => x.id === t.id)).toBeDefined();
	});

	test("arbitrary metadata round-trips on create and update", async () => {
		const created = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "meta",
				description: "d",
				metadata: { source: "email", priority: 3, nested: { a: 1 } },
			})
		).json() as any;
		expect(created.metadata).toEqual({
			source: "email",
			priority: 3,
			nested: { a: 1 },
		});

		const fetched = await (
			await call(app, `${MOUNT}/tickets/${created.id}`, H[USER_ID])
		).json() as any;
		expect(fetched.metadata).toEqual(created.metadata);

		const updated = await (
			await patch(app, `${MOUNT}/tickets/${created.id}`, H[USER_ID], {
				metadata: { source: "web" },
			})
		).json() as any;
		expect(updated.metadata).toEqual({ source: "web" });

		const noMeta = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "no meta",
				description: "d",
			})
		).json() as any;
		expect(noMeta.metadata).toEqual({});
	});

	test("config metadataSchema validates metadata on create and update", async () => {
		const metadataSchema: TicketMetadataSchema<{
			source: "email" | "web";
			priority: number;
		}> = {
			"~standard": {
				version: 1,
				vendor: "spindesk-test",
				validate: (value) => {
					const v = (value ?? {}) as Record<string, unknown>;
					const issues: { message: string }[] = [];
					if (v.source !== "email" && v.source !== "web") {
						issues.push({ message: "source must be 'email' or 'web'" });
					}
					if (typeof v.priority !== "number") {
						issues.push({ message: "priority must be a number" });
					}
					return issues.length
						? { issues }
						: { value: v as { source: "email" | "web"; priority: number } };
				},
			},
		};
		const f = await setup({ metadataSchema });
		const sApp = f.app;
		const sH = f.headers;

		const ok = await post(sApp, `${MOUNT}/tickets`, sH[USER_ID], {
			subject: "s",
			description: "d",
			metadata: { source: "web", priority: 2 },
		});
		expect(ok.ok).toBe(true);
		const created = (await ok.json()) as any;
		expect(created.metadata).toEqual({ source: "web", priority: 2 });

		const badCreate = await post(sApp, `${MOUNT}/tickets`, sH[USER_ID], {
			subject: "s",
			description: "d",
			metadata: { source: "carrier-pigeon", priority: 2 },
		});
		expect(badCreate.status).toBe(400);

		const badUpdate = await patch(
			sApp,
			`${MOUNT}/tickets/${created.id}`,
			sH[USER_ID],
			{ metadata: { source: "web", priority: "high" } },
		);
		expect(badUpdate.status).toBe(400);

		// A configured schema is a guarantee: this one rejects empty metadata, so
		// creating a ticket without metadata is a 400.
		const missing = await post(sApp, `${MOUNT}/tickets`, sH[USER_ID], {
			subject: "s",
			description: "d",
		});
		expect(missing.status).toBe(400);
	});

	test("a metadataSchema that accepts empty keeps metadata optional", async () => {
		// Accepts `{}`/absence, so metadata is not required on create.
		const metadataSchema: TicketMetadataSchema<{ note?: string }> = {
			"~standard": {
				version: 1,
				vendor: "spindesk-test",
				validate: (value) => {
					const v = (value ?? {}) as Record<string, unknown>;
					if (v.note !== undefined && typeof v.note !== "string") {
						return { issues: [{ message: "note must be a string" }] };
					}
					return { value: v as { note?: string } };
				},
			},
		};
		const f = await setup({ metadataSchema });

		const noMeta = await post(f.app, `${MOUNT}/tickets`, f.headers[USER_ID], {
			subject: "s",
			description: "d",
		});
		expect(noMeta.ok).toBe(true);
		expect(((await noMeta.json()) as any).metadata).toEqual({});

		const bad = await post(f.app, `${MOUNT}/tickets`, f.headers[USER_ID], {
			subject: "s",
			description: "d",
			metadata: { note: 123 },
		});
		expect(bad.status).toBe(400);
	});

	test("Lucene filters: status, tag, AND/OR/NOT", async () => {
		const mk = (subject: string, tags: string[]) =>
			post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject,
				description: "d",
				tags,
			});
		const t1 = await (await mk("printer", ["billing"])).json() as any;
		await mk("network", ["bug"]);
		await patch(app, `${MOUNT}/tickets/${t1.id}`, H[AGENT_ID], {
			status: "pending",
		});

		const q = async (query: string) =>
			(await (
				await call(app, `${MOUNT}/tickets?q=${encodeURIComponent(query)}`, H[AGENT_ID])
			).json() as any).total;

		expect(await q("tag:billing")).toBe(1);
		expect(await q("status:pending AND tag:billing")).toBe(1);
		expect(await q("status:pending AND tag:bug")).toBe(0);
		expect(await q("tag:billing OR tag:bug")).toBe(2);
		expect(await q("NOT status:pending")).toBe(1);
		expect(await q("printer")).toBe(1); // bare term matches subject
		expect(await q("network")).toBe(1); // free-text matches other subject
		// invalid Lucene falls back to free text (no 400); "(printer" isn't a
		// substring of any subject/description, so it just returns 0.
		expect(await q("(printer")).toBe(0);
		// unknown field → 400
		expect(
			(await call(app, `${MOUNT}/tickets?q=${encodeURIComponent("bogus:x")}`, H[AGENT_ID]))
				.status,
		).toBe(400);
	});

	test("pagination slices and reports total", async () => {
		for (let i = 0; i < 5; i++) {
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: `t${i}`,
				description: "d",
			});
		}
		const page = await (
			await call(app, `${MOUNT}/tickets?limit=2&offset=0`, H[USER_ID])
		).json() as any;
		expect(page.total).toBe(5);
		expect(page.limit).toBe(2);
		expect(page.tickets).toHaveLength(2);

		const page3 = await (
			await call(app, `${MOUNT}/tickets?limit=2&offset=4`, H[USER_ID])
		).json() as any;
		expect(page3.tickets).toHaveLength(1);
	});

	test("attachments: streamed upload, download, list, 5MB cap, delete", async () => {
		const t = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;
		const aUrl = `${MOUNT}/tickets/${t.id}/attachments`;
		const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

		const up = await call(app, aUrl, H[USER_ID], {
			method: "POST",
			body: payload,
			headers: { "x-filename": "data.bin", "content-type": "application/octet-stream" },
		});
		expect(up.status).toBe(200);
		const meta = await up.json() as any;
		expect(meta.filename).toBe("data.bin");
		expect(meta.size).toBe(10);
		expect(meta.data).toBeUndefined();

		// list excludes data
		const list = await (await call(app, aUrl, H[USER_ID])).json() as any;
		expect(list.total).toBe(1);
		expect(list.attachments[0].data).toBeUndefined();

		// download bytes match
		const dl = await call(app, `${aUrl}/${meta.id}`, H[USER_ID]);
		expect(dl.status).toBe(200);
		expect(new Uint8Array(await dl.arrayBuffer())).toEqual(payload);

		// >5MB rejected (declared via content-length; body streamed)
		const big = new Uint8Array(5 * 1024 * 1024 + 1);
		const tooBig = await call(app, aUrl, H[USER_ID], {
			method: "POST",
			body: big,
			headers: { "x-filename": "big.bin" },
		});
		expect(tooBig.status).toBe(413);

		// unrelated user cannot download
		expect((await call(app, `${aUrl}/${meta.id}`, H[OTHER_ID])).status).toBe(403);

		// delete
		expect((await call(app, `${aUrl}/${meta.id}`, H[USER_ID], { method: "DELETE" })).status).toBe(200);
		const after = await (await call(app, aUrl, H[USER_ID])).json() as any;
		expect(after.total).toBe(0);
	});

	test("GET /tags returns the configured vocabulary", async () => {
		const res = await (await call(app, `${MOUNT}/tags`, H[USER_ID])).json() as any;
		expect(res.tags.sort()).toEqual([...TAGS].sort());
	});

	test("role management is agent-only and can promote a user", async () => {
		// non-agent forbidden
		expect(
			(
				await patch(app, `${MOUNT}/users/${OTHER_ID}/role`, H[USER_ID], {
					role: "agent",
				})
			).status,
		).toBe(403);

		// agent promotes OTHER
		const promoted = await (
			await patch(app, `${MOUNT}/users/${OTHER_ID}/role`, H[AGENT_ID], {
				role: "agent",
			})
		).json() as any;
		expect(promoted).toEqual({ id: OTHER_ID, role: "agent" });

		// now OTHER sees all tickets
		await post(app, `${MOUNT}/tickets`, H[USER_ID], {
			subject: "s",
			description: "d",
		});
		const all = await (await call(app, `${MOUNT}/tickets`, H[OTHER_ID])).json() as any;
		expect(all.total).toBe(1);
		const meOther = await (
			await call(app, `${MOUNT}/me`, H[OTHER_ID])
		).json() as any;
		expect(meOther.role).toBe("agent");
	});

	test("management API key promotes users to agent by id or email", async () => {
		const KEY = "secret-key";
		const f = await setup({ managementApiKey: KEY });
		const mApp = f.app;
		const mH = f.headers;
		const keyed = (body: unknown, key?: string) =>
			post(
				mApp,
				`${MOUNT}/management/agents`,
				new Headers(key ? { authorization: `Bearer ${key}` } : {}),
				body,
			);

		// missing/wrong key rejected
		expect((await keyed({ userId: OTHER_ID })).status).toBe(401);
		expect((await keyed({ userId: OTHER_ID }, "nope")).status).toBe(401);

		// promote by id
		const byId = await (await keyed({ userId: OTHER_ID }, KEY)).json() as any;
		expect(byId).toEqual({ id: OTHER_ID, role: "agent" });
		expect(
			((await (await call(mApp, `${MOUNT}/me`, mH[OTHER_ID])).json()) as any)
				.role,
		).toBe("agent");

		// promote by email
		const byEmail = await (
			await keyed({ email: "user@example.com" }, KEY)
		).json() as any;
		expect(byEmail).toEqual({ id: USER_ID, role: "agent" });

		// unknown email → 404, missing id+email → 400
		expect((await keyed({ email: "nobody@example.com" }, KEY)).status).toBe(404);
		expect((await keyed({}, KEY)).status).toBe(400);
	});

	test("management API is disabled when no key is configured", async () => {
		expect(
			(
				await post(
					app,
					`${MOUNT}/management/agents`,
					new Headers({ authorization: "Bearer anything" }),
					{ userId: OTHER_ID },
				)
			).status,
		).toBe(401);
	});

	test("management key impersonates any user via header, acting as that user", async () => {
		const KEY = "secret-key";
		const f = await setup({ managementApiKey: KEY });
		const mApp = f.app;
		const mH = f.headers;
		const imp = (userId: string, key = KEY) =>
			new Headers({
				authorization: `Bearer ${key}`,
				[IMPERSONATION_HEADER]: userId,
			});
		const tickets = `${MOUNT}/tickets`;

		// impersonation requires a valid management key
		expect(
			(
				await post(
					mApp,
					tickets,
					new Headers({ [IMPERSONATION_HEADER]: USER_ID }),
					{ subject: "s", description: "d" },
				)
			).status,
		).toBe(401);
		expect(
			(
				await post(mApp, tickets, imp(USER_ID, "nope"), {
					subject: "s",
					description: "d",
				})
			).status,
		).toBe(401);

		// create a ticket as USER_ID; it's owned by them and visible in their session
		const created = await (
			await post(mApp, tickets, imp(USER_ID), {
				subject: "on behalf",
				description: "d",
			})
		).json() as any;
		expect(created.userId).toBe(USER_ID);
		const mine = await (await call(mApp, tickets, mH[USER_ID])).json() as any;
		expect(mine.total).toBe(1);
		expect(mine.tickets[0].id).toBe(created.id);

		// acts with the impersonated user's own role: a plain user can't set an
		// agent-only status, nor read another user's ticket
		expect(
			(
				await patch(mApp, `${tickets}/${created.id}`, imp(USER_ID), {
					status: "pending",
				})
			).status,
		).toBe(403);
		const otherTicket = await (
			await post(mApp, tickets, imp(OTHER_ID), {
				subject: "other",
				description: "d",
			})
		).json() as any;
		expect(
			(await call(mApp, `${tickets}/${otherTicket.id}`, imp(USER_ID))).status,
		).toBe(403);

		// impersonating an agent gets agent powers (any status, sees all tickets)
		expect(
			(
				await patch(mApp, `${tickets}/${created.id}`, imp(AGENT_ID), {
					status: "pending",
				})
			).status,
		).toBe(200);
		const all = await (await call(mApp, tickets, imp(AGENT_ID))).json() as any;
		expect(all.total).toBe(2);

		// impersonation reaches every endpoint, including attachment upload
		const up = await call(mApp, `${tickets}/${created.id}/attachments`, imp(USER_ID), {
			method: "POST",
			body: new Uint8Array([1, 2, 3]),
			headers: { "x-filename": "note.txt" },
		});
		expect(up.status).toBe(200);
		expect((await up.json() as any).uploadedBy).toBe(USER_ID);
	});

	test("impersonation is rejected when no management key is configured", async () => {
		expect(
			(
				await post(
					app,
					`${MOUNT}/tickets`,
					new Headers({ [IMPERSONATION_HEADER]: USER_ID }),
					{ subject: "s", description: "d" },
				)
			).status,
		).toBe(401);
	});

	test("validation errors return 400", async () => {
		expect(
			(await post(app, `${MOUNT}/tickets`, H[USER_ID], { subject: "" }))
				.status,
		).toBe(400);
	});

	test("tickets get monotonic numbers, usable as an alternative key", async () => {
		const a = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "a",
				description: "d",
			})
		).json() as any;
		const b = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "b",
				description: "d",
			})
		).json() as any;
		expect(a.number).toBe(1);
		expect(b.number).toBe(2);

		// fetch by number resolves the same ticket as fetching by UUID
		const byNumber = await (
			await call(app, `${MOUNT}/tickets/${b.number}`, H[USER_ID])
		).json() as any;
		expect(byNumber.id).toBe(b.id);

		// access control still applies to the numeric key
		expect(
			(await call(app, `${MOUNT}/tickets/${a.number}`, H[OTHER_ID])).status,
		).toBe(403);

		// comments addressable by number too
		await post(app, `${MOUNT}/tickets/${a.number}/comments`, H[USER_ID], {
			body: "via number",
		});
		const comments = await (
			await call(app, `${MOUNT}/tickets/${a.id}/comments`, H[USER_ID])
		).json() as any;
		expect(comments.total).toBe(1);
	});

	test("missing ticket returns 404", async () => {
		expect(
			(await call(app, `${MOUNT}/tickets/nope`, H[AGENT_ID])).status,
		).toBe(404);
	});
});

describe("comment edit/delete", () => {
	let app: App;
	let H: Record<string, Headers>;

	beforeEach(async () => {
		const f = await setup();
		app = f.app;
		H = f.headers;
	});

	async function ticketWithComment() {
		const ticket = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;
		const comment = await (
			await post(app, `${MOUNT}/tickets/${ticket.id}/comments`, H[USER_ID], {
				body: "original",
			})
		).json() as any;
		return { ticket, comment };
	}

	test("author edits their comment; body and updatedAt change", async () => {
		const { ticket, comment } = await ticketWithComment();
		expect(comment.updatedAt).toBeNull();

		const edited = await (
			await patch(
				app,
				`${MOUNT}/tickets/${ticket.id}/comments/${comment.id}`,
				H[USER_ID],
				{ body: "edited" },
			)
		).json() as any;
		expect(edited.body).toBe("edited");
		expect(typeof edited.updatedAt).toBe("string");
	});

	test("agent may edit; unrelated user may not (403)", async () => {
		const { ticket, comment } = await ticketWithComment();
		expect(
			(
				await patch(
					app,
					`${MOUNT}/tickets/${ticket.id}/comments/${comment.id}`,
					H[AGENT_ID],
					{ body: "by agent" },
				)
			).status,
		).toBe(200);
		expect(
			(
				await patch(
					app,
					`${MOUNT}/tickets/${ticket.id}/comments/${comment.id}`,
					H[OTHER_ID],
					{ body: "hack" },
				)
			).status,
		).toBe(403);
	});

	test("author deletes their comment; unrelated user cannot", async () => {
		const { ticket, comment } = await ticketWithComment();
		expect(
			(
				await del(
					app,
					`${MOUNT}/tickets/${ticket.id}/comments/${comment.id}`,
					H[OTHER_ID],
				)
			).status,
		).toBe(403);

		expect(
			(
				await del(
					app,
					`${MOUNT}/tickets/${ticket.id}/comments/${comment.id}`,
					H[USER_ID],
				)
			).status,
		).toBe(200);

		const after = await (
			await call(app, `${MOUNT}/tickets/${ticket.id}/comments`, H[USER_ID])
		).json() as any;
		expect(after.total).toBe(0);
	});
});

describe("activity log + onActivity hook", () => {
	let app: App;
	let H: Record<string, Headers>;
	let activities: any[];

	beforeEach(async () => {
		activities = [];
		const f = await setup({
			onActivity: async (activity) => {
				activities.push(activity);
			},
		});
		app = f.app;
		H = f.headers;
	});

	const typesFor = (ticketId?: string) =>
		activities
			.filter((a) => ticketId === undefined || a.ticketId === ticketId)
			.map((a) => a.type);

	test("ticket create/update/status/assign/archive emit granular activities", async () => {
		const t = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "orig",
				description: "d",
			})
		).json() as any;

		const created = activities.find((a) => a.type === "ticket-created");
		expect(created.ticketId).toBe(t.id);
		expect(created.ticket.subject).toBe("orig");
		expect(created.actor).toEqual({ id: USER_ID, role: "user" });

		await patch(app, `${MOUNT}/tickets/${t.id}`, H[USER_ID], {
			subject: "renamed",
		});
		await patch(app, `${MOUNT}/tickets/${t.id}`, H[AGENT_ID], {
			status: "pending",
			assigneeId: AGENT_ID,
		});
		await patch(app, `${MOUNT}/tickets/${t.id}`, H[USER_ID], {
			archived: true,
		});
		await patch(app, `${MOUNT}/tickets/${t.id}`, H[USER_ID], {
			archived: false,
		});

		const updated = activities.find((a) => a.type === "ticket-updated");
		expect(updated.changedFields).toContain("subject");

		const status = activities.find((a) => a.type === "ticket-status-changed");
		expect(status.from).toBe("open");
		expect(status.to).toBe("pending");

		const assigned = activities.find((a) => a.type === "ticket-assigned");
		expect(assigned.from).toBeNull();
		expect(assigned.to).toBe(AGENT_ID);

		expect(typesFor(t.id)).toContain("ticket-archived");
		expect(typesFor(t.id)).toContain("ticket-unarchived");
	});

	test("adding a comment emits comment-created, not ticket-updated", async () => {
		const t = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;
		activities.length = 0;

		await post(app, `${MOUNT}/tickets/${t.id}/comments`, H[USER_ID], {
			body: "hi",
		});
		expect(typesFor(t.id)).toEqual(["comment-created"]);
	});

	test("comment edit/delete emit comment-edited/comment-deleted", async () => {
		const t = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;
		const c = await (
			await post(app, `${MOUNT}/tickets/${t.id}/comments`, H[USER_ID], {
				body: "orig",
			})
		).json() as any;

		await patch(
			app,
			`${MOUNT}/tickets/${t.id}/comments/${c.id}`,
			H[USER_ID],
			{ body: "new" },
		);
		await del(app, `${MOUNT}/tickets/${t.id}/comments/${c.id}`, H[USER_ID]);

		const edited = activities.find((a) => a.type === "comment-edited");
		expect(edited.commentId).toBe(c.id);
		expect(edited.comment.body).toBe("new");
		const deleted = activities.find((a) => a.type === "comment-deleted");
		expect(deleted.commentId).toBe(c.id);
	});

	test("role change and attachment lifecycle emit activities", async () => {
		await patch(app, `${MOUNT}/users/${OTHER_ID}/role`, H[AGENT_ID], {
			role: "agent",
		});
		const role = activities.find((a) => a.type === "user-role-changed");
		expect(role.userId).toBe(OTHER_ID);
		expect(role.to).toBe("agent");

		const t = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;
		const up = await (
			await call(app, `${MOUNT}/tickets/${t.id}/attachments`, H[USER_ID], {
				method: "POST",
				body: new Uint8Array([1, 2, 3]),
				headers: { "x-filename": "a.bin" },
			})
		).json() as any;
		await del(app, `${MOUNT}/tickets/${t.id}/attachments/${up.id}`, H[USER_ID]);

		expect(typesFor(t.id)).toContain("attachment-created");
		expect(typesFor(t.id)).toContain("attachment-deleted");
	});

	test("GET /activities is access-scoped; agent sees all, user sees own", async () => {
		const mine = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "mine",
				description: "d",
			})
		).json() as any;
		await post(app, `${MOUNT}/tickets`, H[OTHER_ID], {
			subject: "theirs",
			description: "d",
		});

		const agentFeed = await (
			await call(app, `${MOUNT}/activities`, H[AGENT_ID])
		).json() as any;
		expect(agentFeed.total).toBe(2);
		// newest first
		expect(agentFeed.activities[0].createdAt >= agentFeed.activities[1].createdAt).toBe(true);

		const userFeed = await (
			await call(app, `${MOUNT}/activities`, H[USER_ID])
		).json() as any;
		expect(userFeed.total).toBe(1);
		expect(userFeed.activities[0].ticketId).toBe(mine.id);

		// type filter + pagination
		const filtered = await (
			await call(
				app,
				`${MOUNT}/activities?type=ticket-created&limit=1`,
				H[AGENT_ID],
			)
		).json() as any;
		expect(filtered.total).toBe(2);
		expect(filtered.activities).toHaveLength(1);
		expect(filtered.activities[0].type).toBe("ticket-created");
	});

	test("GET /tickets/:id/activities scoped to the ticket, denied to strangers", async () => {
		const t = await (
			await post(app, `${MOUNT}/tickets`, H[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;
		await patch(app, `${MOUNT}/tickets/${t.id}`, H[AGENT_ID], {
			status: "pending",
		});

		const feed = await (
			await call(app, `${MOUNT}/tickets/${t.id}/activities`, H[USER_ID])
		).json() as any;
		expect(feed.activities.map((a: any) => a.type).sort()).toEqual(
			["ticket-created", "ticket-status-changed"].sort(),
		);

		expect(
			(await call(app, `${MOUNT}/tickets/${t.id}/activities`, H[OTHER_ID]))
				.status,
		).toBe(403);
	});
});

describe("activity persistence without a hook", () => {
	test("activities are persisted even when no onActivity is configured", async () => {
		const f = await setup();
		const t = await (
			await post(f.app, `${MOUNT}/tickets`, f.headers[USER_ID], {
				subject: "s",
				description: "d",
			})
		).json() as any;
		const feed = await (
			await call(f.app, `${MOUNT}/activities`, f.headers[USER_ID])
		).json() as any;
		expect(feed.total).toBe(1);
		expect(feed.activities[0].type).toBe("ticket-created");
		expect(feed.activities[0].ticketId).toBe(t.id);
	});

	test("a throwing onActivity hook does not fail the request or the write", async () => {
		const f = await setup({
			onActivity: async () => {
				throw new Error("boom");
			},
		});
		const res = await post(f.app, `${MOUNT}/tickets`, f.headers[USER_ID], {
			subject: "s",
			description: "d",
		});
		expect(res.status).toBe(200);
		const feed = await (
			await call(f.app, `${MOUNT}/activities`, f.headers[USER_ID])
		).json() as any;
		expect(feed.total).toBe(1);
	});
});
