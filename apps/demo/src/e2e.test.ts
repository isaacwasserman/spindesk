/**
 * End-to-end tests for the service-desk stack.
 *
 * Each test gets a fresh in-memory SQLite via createApp(), exercising the full
 * better-auth → futonic → service-desk → SQLite path. Authenticated headers are
 * minted with the better-auth `testUtils` plugin — no manual sign-in flow.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type App, createApp } from "./host/server";

// Fixed ids so we can seed agentUserIds before the users exist.
const AGENT_ID = "agent-1";
const USER_ID = "user-1";
const OTHER_ID = "user-2";
const MOUNT = "/api/servicedesk";

interface Fixture {
	app: App;
	headers: Record<string, Headers>; // by user id
}

const TAGS = ["billing", "bug", "urgent"];

async function setup(): Promise<Fixture> {
	const app = await createApp({ agentUserIds: [AGENT_ID], availableTags: TAGS });
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

	test("validation errors return 400", async () => {
		expect(
			(await post(app, `${MOUNT}/tickets`, H[USER_ID], { subject: "" }))
				.status,
		).toBe(400);
	});

	test("missing ticket returns 404", async () => {
		expect(
			(await call(app, `${MOUNT}/tickets/nope`, H[AGENT_ID])).status,
		).toBe(404);
	});
});
