import { APIError, type Middleware, createEndpoint } from "better-call";
import { z } from "zod";
import { requireAgent } from "./auth-middleware";
import { toCamel, toCamelList } from "./case";
import { mentionsArchived, parseLuceneToFilter } from "./filter";
import { resolveUserNames } from "./names";
import {
	type Ctx,
	DEFAULT_MAX_ATTACHMENT_BYTES,
	type Role,
	type ServiceDeskConfig,
	type SvcCtx,
	TICKET_STATUS,
} from "./types";

/** A better-call `Where` clause. */
type Where = { field: string; value: unknown };
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
	"ticket_id",
	"filename",
	"content_type",
	"size",
	"uploaded_by",
	"created_at",
];

/** Tags are stored as a JSON array of unique tokens: ["billing","urgent"]. */
function serializeTags(tags: string[]): string | null {
	const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
	return cleaned.length ? JSON.stringify(cleaned) : null;
}
function parseTags(value: unknown): string[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
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
		tickets.flatMap((t) => [
			t.user_id as string,
			t.assignee_id as string | null,
		]),
	);
	return tickets.map((t) => ({
		...t,
		tags: parseTags(t.tags),
		user_name: names.get(t.user_id as string)?.name ?? null,
		assignee_name: t.assignee_id
			? (names.get(t.assignee_id as string)?.name ?? null)
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
		comments.map((c) => c.author_id as string),
	);
	return comments.map((c) => ({
		...c,
		author_name: names.get(c.author_id as string)?.name ?? null,
	}));
}

/**
 * Loads a ticket by id and enforces read access: agents see everything, users
 * only their own. Throws 404/403 as appropriate.
 */
async function getAccessibleTicket(ctx: Ctx["context"], id: string) {
	const { serviceCtx: svc, serviceDesk } = ctx;
	const ticket = await svc.db.tickets.findOne([{ field: "id", value: id }]);
	if (!ticket) {
		throw new APIError("NOT_FOUND", { message: "Ticket not found" });
	}
	if (serviceDesk.role !== "agent" && ticket.user_id !== serviceDesk.userId) {
		throw new APIError("FORBIDDEN", { message: "Not your ticket" });
	}
	return ticket;
}

/**
 * Builds all service-desk endpoints. `use` is the middleware chain (service
 * context + auth) supplied by the router factory at mount time.
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
			const ticket = await svc.db.tickets.create({
				id: crypto.randomUUID(),
				user_id: serviceDesk.userId,
				subject: ctx.body.subject,
				description: ctx.body.description,
				status: "open",
				assignee_id: null,
				tags: serializeTags(tags),
				archived_at: null,
				created_at: now,
				updated_at: now,
			});
			svc.logger.info(`Ticket created: ${ticket.id}`);
			return toCamel(await enrichTicket(svc, ticket));
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
			const nodes: import("./filter").FilterNode[] = [];
			if (serviceDesk.role !== "agent") {
				nodes.push({
					type: "cond",
					field: "user_id",
					op: "eq",
					value: serviceDesk.userId,
				});
			}
			if (!mentionsArchived(q)) {
				nodes.push({ type: "cond", field: "archived_at", op: "isNull" });
			}
			const parsed = parseLuceneToFilter(q);
			if (parsed) nodes.push(parsed);
			const filter = { type: "and" as const, nodes };

			const tickets = await svc.db.tickets.findMany({
				filter,
				sortBy: { field: "created_at", direction: "desc" },
				limit,
				offset,
			});
			const total = await svc.db.tickets.count({ filter });
			return {
				tickets: toCamelList(await enrichTickets(svc, tickets)),
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
			return toCamel(await enrichTicket(context.serviceCtx, ticket));
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
			const isOwner = ticket.user_id === serviceDesk.userId;

			const data: Record<string, unknown> = {};

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
				data.archived_at = ctx.body.archived ? new Date().toISOString() : null;
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
				data.assignee_id = ctx.body.assigneeId;
			}
			if (Object.keys(data).length === 0) {
				return toCamel(await enrichTicket(svc, ticket));
			}

			data.updated_at = new Date().toISOString();
			const updated = await svc.db.tickets.update(
				[{ field: "id", value: id }],
				data,
			);
			return toCamel(await enrichTicket(svc, updated));
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
			// from each comment's `parent_id`.
			const comments = await svc.db.comments.findMany({
				where: [{ field: "ticket_id", value: id }],
				sortBy: { field: "created_at", direction: "asc" },
			});
			return {
				comments: toCamelList(await enrichComments(svc, comments)),
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
				const parent = await svc.db.comments.findOne([
					{ field: "id", value: parentId },
				]);
				if (!parent || parent.ticket_id !== id) {
					throw new APIError("BAD_REQUEST", {
						message: "Invalid parent comment",
					});
				}
			}

			const now = new Date().toISOString();
			const comment = await svc.db.comments.create({
				id: crypto.randomUUID(),
				ticket_id: id,
				parent_id: parentId,
				author_id: serviceDesk.userId,
				author_role: serviceDesk.role,
				body: ctx.body.body,
				created_at: now,
			});
			// Bump ticket activity timestamp.
			await svc.db.tickets.update([{ field: "id", value: id }], {
				updated_at: now,
			});
			return toCamel((await enrichComments(svc, [comment]))[0] as Row);
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

			const existing = await svc.db.users.findOne([{ field: "id", value: id }]);
			const row = existing
				? await svc.db.users.update([{ field: "id", value: id }], {
						role,
					})
				: await svc.db.users.create({
						id,
						role,
						created_at: new Date().toISOString(),
					});
			return { id, role: row.role as Role };
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

			const row = await svc.db.attachments.create({
				id: crypto.randomUUID(),
				ticket_id: id,
				filename,
				content_type: contentType,
				size,
				data,
				uploaded_by: serviceDesk.userId,
				created_at: new Date().toISOString(),
			});
			svc.logger.info(`Attachment stored: ${row.id} (${size} bytes)`);
			const { data: _data, ...meta } = row;
			return toCamel(meta);
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
			const rows = await svc.db.attachments.findMany({
				where: [{ field: "ticket_id", value: id }],
				select: ATTACHMENT_META,
				sortBy: { field: "created_at", direction: "asc" },
			});
			return { attachments: toCamelList(rows), total: rows.length };
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
			const row = await svc.db.attachments.findOne([
				{ field: "id", value: attId },
			]);
			if (!row || row.ticket_id !== id) {
				throw new APIError("NOT_FOUND", { message: "Attachment not found" });
			}
			const raw = row.data as Uint8Array | ArrayBufferLike;
			const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
			return new Response(bytes as unknown as BodyInit, {
				headers: {
					"content-type": String(row.content_type),
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
			const row = await svc.db.attachments.findOne([
				{ field: "id", value: attId },
			]);
			if (!row || row.ticket_id !== id) {
				throw new APIError("NOT_FOUND", { message: "Attachment not found" });
			}
			const isAgent = serviceDesk.role === "agent";
			const isOwner = ticket.user_id === serviceDesk.userId;
			if (!isAgent && !isOwner) {
				throw new APIError("FORBIDDEN", { message: "Not allowed" });
			}
			await svc.db.attachments.delete([{ field: "id", value: attId }]);
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
