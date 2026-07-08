import { APIError, type Middleware, createEndpoint } from "better-call";
import {
	type Expression,
	type ExpressionBuilder,
	type SqlBool,
	sql,
} from "kysely";
import { z } from "zod";
import { requireAgent } from "./auth-middleware";
import {
	type FilterNode,
	mentionsArchived,
	parseLuceneToFilter,
} from "./filter";
import { resolveUserNames } from "./names";
import {
	type Ctx,
	DEFAULT_MAX_ATTACHMENT_BYTES,
	type Role,
	type ServiceDeskConfig,
	type SvcCtx,
	TICKET_STATUS,
} from "./types";

/**
 * A flat DB row. futonic's Kysely instance installs a `CamelCasePlugin`, so
 * rows already come back camelCase — the API vocabulary — with no conversion.
 */
type Row = Record<string, unknown>;

function configOf(svc: SvcCtx): ServiceDeskConfig {
	return svc.config as unknown as ServiceDeskConfig;
}
function authOf(svc: SvcCtx) {
	return configOf(svc).auth;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Attachment metadata columns (everything except the binary `data` blob). */
const ATTACHMENT_META = [
	"id",
	"ticketId",
	"filename",
	"contentType",
	"size",
	"uploadedBy",
	"createdAt",
] as const;

const ALWAYS_TRUE = sql<SqlBool>`1 = 1`;

/**
 * Translate a `FilterNode` tree into a Kysely boolean expression over the
 * ticket columns. Column names are camelCase keys; the `CamelCasePlugin` maps
 * them to snake_case in the emitted SQL.
 */
function ticketFilterExpression(
	// biome-ignore lint/suspicious/noExplicitAny: builder over a dynamic column set
	eb: ExpressionBuilder<any, any>,
	node: FilterNode,
): Expression<SqlBool> {
	switch (node.type) {
		case "and": {
			const parts = node.nodes.map((n) => ticketFilterExpression(eb, n));
			return parts.length ? eb.and(parts) : ALWAYS_TRUE;
		}
		case "or": {
			const parts = node.nodes.map((n) => ticketFilterExpression(eb, n));
			return parts.length ? eb.or(parts) : ALWAYS_TRUE;
		}
		case "not":
			return eb.not(ticketFilterExpression(eb, node.node));
		case "cond": {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic column ref
			const field = node.field as any;
			const value = node.value;
			switch (node.op) {
				case "eq":
					return eb(field, "=", value);
				case "ne":
					return eb(field, "<>", value);
				case "gt":
					return eb(field, ">", value);
				case "gte":
					return eb(field, ">=", value);
				case "lt":
					return eb(field, "<", value);
				case "lte":
					return eb(field, "<=", value);
				case "in":
					return eb(field, "in", value as unknown[]);
				case "not_in":
					return eb(field, "not in", value as unknown[]);
				case "contains":
					return eb(field, "like", `%${value}%`);
				case "startsWith":
					return eb(field, "like", `${value}%`);
				case "endsWith":
					return eb(field, "like", `%${value}`);
				case "isNull":
					return eb(field, "is", null);
				case "isNotNull":
					return eb(field, "is not", null);
			}
		}
	}
}

/** Whether a top-level AND/OR node carries any clauses to apply. */
function hasClauses(node: FilterNode): boolean {
	return node.type === "and" || node.type === "or"
		? node.nodes.length > 0
		: true;
}

/** Tags are stored as a JSON array of unique tokens: ["billing","urgent"]. */
function serializeTags(tags: string[]): string | null {
	const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
	return cleaned.length ? JSON.stringify(cleaned) : null;
}
function parseTags(value: unknown): string[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((t) => typeof t === "string")
			: [];
	} catch {
		return [];
	}
}
/** Validate tags against the configured vocabulary (if any); 400 on unknown. */
function validateTags(svc: SvcCtx, tags: string[]): void {
	const allowed = configOf(svc).availableTags;
	if (!allowed) return;
	for (const tag of tags) {
		if (!allowed.includes(tag)) {
			throw new APIError("BAD_REQUEST", { message: `Unknown tag: ${tag}` });
		}
	}
}

/** Attach live owner/assignee display names (from better-auth) + tags array to tickets. */
async function enrichTickets(svc: SvcCtx, tickets: Row[]): Promise<Row[]> {
	const names = await resolveUserNames(
		authOf(svc),
		tickets.flatMap((t) => [t.userId as string, t.assigneeId as string | null]),
	);
	return tickets.map((t) => ({
		...t,
		tags: parseTags(t.tags),
		userName: names.get(t.userId as string)?.name ?? null,
		assigneeName: t.assigneeId
			? (names.get(t.assigneeId as string)?.name ?? null)
			: null,
	}));
}

async function enrichTicket(svc: SvcCtx, ticket: Row): Promise<Row> {
	return (await enrichTickets(svc, [ticket]))[0] as Row;
}

/** Attach live author display names (from better-auth) to comments. */
async function enrichComments(svc: SvcCtx, comments: Row[]): Promise<Row[]> {
	const names = await resolveUserNames(
		authOf(svc),
		comments.map((c) => c.authorId as string),
	);
	return comments.map((c) => ({
		...c,
		authorName: names.get(c.authorId as string)?.name ?? null,
	}));
}

/**
 * Loads a ticket by id and enforces read access: agents see everything, users
 * only their own. Throws 404/403 as appropriate.
 */
async function getAccessibleTicket(ctx: Ctx["context"], id: string) {
	const { serviceCtx: svc, serviceDesk } = ctx;
	const ticket = await svc.db
		.selectFrom("tickets")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirst();
	if (!ticket) {
		throw new APIError("NOT_FOUND", { message: "Ticket not found" });
	}
	if (serviceDesk.role !== "agent" && ticket.userId !== serviceDesk.userId) {
		throw new APIError("FORBIDDEN", { message: "Not your ticket" });
	}
	return ticket as Row;
}

/**
 * Builds all service-desk endpoints. `use` is the middleware chain (service
 * context + auth) supplied by the constructor's endpoints factory at build time.
 */
export function createServiceDeskEndpoints(use: Middleware[]) {
	/** Current user's service-desk profile — lets the host UI branch on role. */
	const me = createEndpoint("/me", { method: "GET", use }, async (ctx) => {
		const { serviceCtx: svc, serviceDesk } = (ctx as unknown as Ctx).context;
		const names = await resolveUserNames(authOf(svc), [serviceDesk.userId]);
		return {
			id: serviceDesk.userId,
			role: serviceDesk.role,
			name: names.get(serviceDesk.userId)?.name ?? null,
		};
	});

	const createTicket = createEndpoint(
		"/tickets",
		{
			method: "POST",
			use,
			body: z.object({
				subject: z.string().min(1),
				description: z.string().min(1),
				tags: z.array(z.string()).optional(),
			}),
		},
		async (ctx) => {
			const { serviceCtx: svc, serviceDesk } = (ctx as unknown as Ctx).context;
			const tags = ctx.body.tags ?? [];
			validateTags(svc, tags);
			const now = new Date().toISOString();
			const ticket = {
				id: crypto.randomUUID(),
				userId: serviceDesk.userId,
				subject: ctx.body.subject,
				description: ctx.body.description,
				status: "open",
				assigneeId: null,
				tags: serializeTags(tags),
				archivedAt: null,
				createdAt: now,
				updatedAt: now,
			};
			await svc.db.insertInto("tickets").values(ticket).execute();
			svc.logger.info(`Ticket created: ${ticket.id}`);
			return await enrichTicket(svc, ticket);
		},
	);

	const listTickets = createEndpoint(
		"/tickets",
		{ method: "GET", use },
		async (ctx) => {
			const { serviceCtx: svc, serviceDesk } = (ctx as unknown as Ctx).context;
			const url = new URL((ctx.request as Request).url);
			const q = url.searchParams.get("q") ?? "";

			// Pagination.
			const limit = Math.min(
				Math.max(Number(url.searchParams.get("limit")) || DEFAULT_LIMIT, 1),
				MAX_LIMIT,
			);
			const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

			// Compose the filter tree: mandatory ownership scoping + a default
			// "hide archived" clause + the user's Lucene query. Ownership can't
			// be overridden by `q`.
			const nodes: FilterNode[] = [];
			if (serviceDesk.role !== "agent") {
				nodes.push({
					type: "cond",
					field: "userId",
					op: "eq",
					value: serviceDesk.userId,
				});
			}
			if (!mentionsArchived(q)) {
				nodes.push({ type: "cond", field: "archivedAt", op: "isNull" });
			}
			const parsed = parseLuceneToFilter(q);
			if (parsed) nodes.push(parsed);
			const filter: FilterNode = { type: "and", nodes };

			let listQuery = svc.db.selectFrom("tickets").selectAll();
			let countQuery = svc.db
				.selectFrom("tickets")
				.select((eb) => eb.fn.countAll().as("count"));
			if (hasClauses(filter)) {
				listQuery = listQuery.where((eb) => ticketFilterExpression(eb, filter));
				countQuery = countQuery.where((eb) =>
					ticketFilterExpression(eb, filter),
				);
			}

			const tickets = (await listQuery
				.orderBy("createdAt", "desc")
				.limit(limit)
				.offset(offset)
				.execute()) as Row[];
			const countRow = await countQuery.executeTakeFirst();
			const total = Number(countRow?.count ?? 0);
			return {
				tickets: await enrichTickets(svc, tickets),
				total,
				limit,
				offset,
			};
		},
	);

	const getTicket = createEndpoint(
		"/tickets/:id",
		{ method: "GET", use },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { id } = ctx.params as { id: string };
			const ticket = await getAccessibleTicket(context, id);
			return await enrichTicket(context.serviceCtx, ticket);
		},
	);

	const updateTicket = createEndpoint(
		"/tickets/:id",
		{
			method: "PATCH",
			use,
			body: z.object({
				// Author-editable content.
				subject: z.string().min(1).optional(),
				description: z.string().min(1).optional(),
				tags: z.array(z.string()).optional(),
				archived: z.boolean().optional(),
				// Agent-only workflow fields.
				status: z.enum(TICKET_STATUS).optional(),
				assigneeId: z.string().nullable().optional(),
			}),
		},
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc, serviceDesk } = context;
			const { id } = ctx.params as { id: string };
			const ticket = await getAccessibleTicket(context, id);
			const isAgent = serviceDesk.role === "agent";
			const isOwner = ticket.userId === serviceDesk.userId;

			const data: Row = {};

			// Author (or agent) may edit content, tags, and archive state.
			const editsContent =
				ctx.body.subject !== undefined ||
				ctx.body.description !== undefined ||
				ctx.body.tags !== undefined ||
				ctx.body.archived !== undefined;
			if (editsContent && !isOwner && !isAgent) {
				throw new APIError("FORBIDDEN", { message: "Not your ticket" });
			}
			if (ctx.body.subject !== undefined) data.subject = ctx.body.subject;
			if (ctx.body.description !== undefined) {
				data.description = ctx.body.description;
			}
			if (ctx.body.tags !== undefined) {
				validateTags(svc, ctx.body.tags);
				data.tags = serializeTags(ctx.body.tags);
			}
			if (ctx.body.archived !== undefined) {
				data.archivedAt = ctx.body.archived ? new Date().toISOString() : null;
			}

			if (ctx.body.status !== undefined) {
				// Owners may only open/close their own tickets; agents set any status.
				if (
					!isAgent &&
					ctx.body.status !== "open" &&
					ctx.body.status !== "closed"
				) {
					throw new APIError("FORBIDDEN", {
						message: "Only agents can set that status",
					});
				}
				data.status = ctx.body.status;
			}
			if (ctx.body.assigneeId !== undefined) {
				if (!isAgent) {
					throw new APIError("FORBIDDEN", {
						message: "Only agents can assign tickets",
					});
				}
				data.assigneeId = ctx.body.assigneeId;
			}
			if (Object.keys(data).length === 0) {
				return await enrichTicket(svc, ticket);
			}

			data.updatedAt = new Date().toISOString();
			await svc.db
				.updateTable("tickets")
				.set(data as never)
				.where("id", "=", id)
				.execute();
			const updated = (await svc.db
				.selectFrom("tickets")
				.selectAll()
				.where("id", "=", id)
				.executeTakeFirstOrThrow()) as Row;
			return await enrichTicket(svc, updated);
		},
	);

	const listComments = createEndpoint(
		"/tickets/:id/comments",
		{ method: "GET", use },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc } = context;
			const { id } = ctx.params as { id: string };
			await getAccessibleTicket(context, id); // authorize
			// Flat, chronological list; the client assembles the reply tree
			// from each comment's `parentId`.
			const comments = (await svc.db
				.selectFrom("comments")
				.selectAll()
				.where("ticketId", "=", id)
				.orderBy("createdAt", "asc")
				.execute()) as Row[];
			return {
				comments: await enrichComments(svc, comments),
				total: comments.length,
			};
		},
	);

	const addComment = createEndpoint(
		"/tickets/:id/comments",
		{
			method: "POST",
			use,
			body: z.object({
				body: z.string().min(1),
				parentId: z.string().nullable().optional(),
			}),
		},
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc, serviceDesk } = context;
			const { id } = ctx.params as { id: string };
			await getAccessibleTicket(context, id); // authorize

			// A reply must target an existing comment on the same ticket.
			const parentId = ctx.body.parentId ?? null;
			if (parentId) {
				const parent = await svc.db
					.selectFrom("comments")
					.selectAll()
					.where("id", "=", parentId)
					.executeTakeFirst();
				if (!parent || parent.ticketId !== id) {
					throw new APIError("BAD_REQUEST", {
						message: "Invalid parent comment",
					});
				}
			}

			const now = new Date().toISOString();
			const comment = {
				id: crypto.randomUUID(),
				ticketId: id,
				parentId,
				authorId: serviceDesk.userId,
				authorRole: serviceDesk.role,
				body: ctx.body.body,
				createdAt: now,
			};
			await svc.db.insertInto("comments").values(comment).execute();
			// Bump ticket activity timestamp.
			await svc.db
				.updateTable("tickets")
				.set({ updatedAt: now })
				.where("id", "=", id)
				.execute();
			return (await enrichComments(svc, [comment]))[0] as Row;
		},
	);

	/** Agent-only: promote/demote another user's role (lazily provisions row). */
	const setUserRole = createEndpoint(
		"/users/:id/role",
		{
			method: "PATCH",
			use,
			body: z.object({ role: z.enum(["user", "agent"]) }),
		},
		async (ctx) => {
			const { serviceCtx: svc, serviceDesk } = (ctx as unknown as Ctx).context;
			requireAgent(serviceDesk);
			const { id } = ctx.params as { id: string };
			const role = ctx.body.role as Role;

			const existing = await svc.db
				.selectFrom("users")
				.selectAll()
				.where("id", "=", id)
				.executeTakeFirst();
			if (existing) {
				await svc.db
					.updateTable("users")
					.set({ role })
					.where("id", "=", id)
					.execute();
			} else {
				await svc.db
					.insertInto("users")
					.values({ id, role, createdAt: new Date().toISOString() })
					.execute();
			}
			return { id, role };
		},
	);

	/** Available tag vocabulary, for the host UI's tag picker. */
	const listTags = createEndpoint(
		"/tags",
		{ method: "GET", use },
		async (ctx) => {
			const { serviceCtx: svc } = (ctx as unknown as Ctx).context;
			return { tags: configOf(svc).availableTags ?? [] };
		},
	);

	/**
	 * Streamed file upload. `disableBody` stops better-call from buffering the
	 * body; we read `ctx.request.body` as a stream and enforce the size cap
	 * incrementally, aborting early on overflow (413).
	 */
	const uploadAttachment = createEndpoint(
		"/tickets/:id/attachments",
		{ method: "POST", use, disableBody: true, requireRequest: true },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc, serviceDesk } = context;
			const { id } = ctx.params as { id: string };
			await getAccessibleTicket(context, id);

			const req = ctx.request as Request;
			const max =
				configOf(svc).maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
			const tooLarge = () => {
				throw new APIError("PAYLOAD_TOO_LARGE", {
					message: `Attachment exceeds ${max} bytes`,
				});
			};

			// Fast reject on declared size, then enforce during streaming.
			const declared = Number(req.headers.get("content-length") || 0);
			if (declared > max) tooLarge();
			if (!req.body) {
				throw new APIError("BAD_REQUEST", { message: "Empty upload" });
			}
			const filename = req.headers.get("x-filename") || "upload.bin";
			const contentType =
				req.headers.get("content-type") || "application/octet-stream";

			const reader = req.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				size += value.byteLength;
				if (size > max) {
					await reader.cancel();
					tooLarge();
				}
				chunks.push(value);
			}
			const data = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				data.set(chunk, offset);
				offset += chunk.byteLength;
			}

			const row = {
				id: crypto.randomUUID(),
				ticketId: id,
				filename,
				contentType,
				size,
				data,
				uploadedBy: serviceDesk.userId,
				createdAt: new Date().toISOString(),
			};
			await svc.db.insertInto("attachments").values(row).execute();
			svc.logger.info(`Attachment stored: ${row.id} (${size} bytes)`);
			const { data: _data, ...meta } = row;
			return meta;
		},
	);

	const listAttachments = createEndpoint(
		"/tickets/:id/attachments",
		{ method: "GET", use },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc } = context;
			const { id } = ctx.params as { id: string };
			await getAccessibleTicket(context, id);
			// Metadata only — never load the blobs to list them.
			const rows = await svc.db
				.selectFrom("attachments")
				.select([...ATTACHMENT_META])
				.where("ticketId", "=", id)
				.orderBy("createdAt", "asc")
				.execute();
			return { attachments: rows, total: rows.length };
		},
	);

	const downloadAttachment = createEndpoint(
		"/tickets/:id/attachments/:attId",
		{ method: "GET", use },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc } = context;
			const { id, attId } = ctx.params as { id: string; attId: string };
			await getAccessibleTicket(context, id);
			const row = await svc.db
				.selectFrom("attachments")
				.selectAll()
				.where("id", "=", attId)
				.executeTakeFirst();
			if (!row || row.ticketId !== id) {
				throw new APIError("NOT_FOUND", { message: "Attachment not found" });
			}
			const raw = row.data as Uint8Array | ArrayBufferLike;
			const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
			return new Response(bytes as unknown as BodyInit, {
				headers: {
					"content-type": String(row.contentType),
					"content-length": String(row.size),
					"content-disposition": `attachment; filename="${String(
						row.filename,
					).replace(/"/g, "")}"`,
				},
			});
		},
	);

	const deleteAttachment = createEndpoint(
		"/tickets/:id/attachments/:attId",
		{ method: "DELETE", use },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc, serviceDesk } = context;
			const { id, attId } = ctx.params as { id: string; attId: string };
			const ticket = await getAccessibleTicket(context, id);
			const row = await svc.db
				.selectFrom("attachments")
				.selectAll()
				.where("id", "=", attId)
				.executeTakeFirst();
			if (!row || row.ticketId !== id) {
				throw new APIError("NOT_FOUND", { message: "Attachment not found" });
			}
			const isAgent = serviceDesk.role === "agent";
			const isOwner = ticket.userId === serviceDesk.userId;
			if (!isAgent && !isOwner) {
				throw new APIError("FORBIDDEN", { message: "Not allowed" });
			}
			await svc.db.deleteFrom("attachments").where("id", "=", attId).execute();
			return { ok: true };
		},
	);

	return {
		me,
		listTags,
		createTicket,
		listTickets,
		getTicket,
		updateTicket,
		listComments,
		addComment,
		setUserRole,
		uploadAttachment,
		listAttachments,
		downloadAttachment,
		deleteAttachment,
	};
}
