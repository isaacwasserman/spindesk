import { APIError } from "better-call";
import {
	type Expression,
	type ExpressionBuilder,
	type Kysely,
	PostgresAdapter,
	type SqlBool,
	sql,
} from "kysely";
import { z } from "zod";
import { type Actor, recordActivity } from "./activity.js";
import {
	requireAgent,
	requireManagementKey,
	resolveIdentity,
} from "./auth-middleware.js";
import {
	type FilterNode,
	mentionsArchived,
	parseLuceneToFilter,
} from "./filter.js";
import { resolveUserIdByEmail, resolveUserNames } from "./names.js";
import {
	type Ctx,
	DEFAULT_MAX_ATTACHMENT_BYTES,
	type DefineServiceDeskEndpoint,
	type Role,
	type ServiceDeskConfig,
	type SvcCtx,
	TICKET_STATUS,
	type TicketStatus,
} from "./types.js";

/**
 * Row shapes come straight from the typed Kysely instance (`svc.db`), whose
 * schema futonic derives from `ServiceDeskSchema`. They're the enrich-step
 * inputs; the response DTOs are the `*Schema` outputs below.
 */
type DB = SvcCtx["db"] extends Kysely<infer S> ? S : never;
type TicketRow = DB["tickets"];
type CommentRow = DB["comments"];

/**
 * Endpoint response schemas. Each is attached to its endpoint via `output`,
 * which drives the OpenAPI `200` body, the typed client's result type, and a
 * compile-time check on the handler's return value.
 */
const roleSchema = z.enum(["user", "agent"]);

/**
 * Ticket `metadata` is opaque host-supplied key/value data. It defaults to an
 * open record; a host can pin its shape with the `M` type argument on
 * `createSpindesk`/`createSpindeskClient`, which flows through the schema
 * factories below to the endpoint bodies, outputs, and the typed client.
 */
export type TicketMetadata = Record<string, unknown>;

/**
 * A metadata field whose static type is `M` on both input and output. The
 * runtime schema is an open record — validation stays shape-agnostic; `M` is a
 * compile-time view the caller vouches for.
 */
function metadataField<M extends TicketMetadata>() {
	return z.record(z.string(), z.unknown()) as unknown as z.ZodType<M, M>;
}

function ticketSchemaFor<M extends TicketMetadata>() {
	return z.object({
		id: z.string(),
		number: z.number(),
		userId: z.string(),
		userName: z.string().nullable(),
		subject: z.string(),
		description: z.string(),
		status: z.enum(TICKET_STATUS),
		assigneeId: z.string().nullable(),
		assigneeName: z.string().nullable(),
		tags: z.array(z.string()),
		metadata: metadataField<M>(),
		archivedAt: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
	});
}

const commentSchema = z.object({
	id: z.string(),
	ticketId: z.string(),
	parentId: z.string().nullable(),
	authorId: z.string(),
	authorName: z.string().nullable(),
	authorRole: roleSchema,
	body: z.string(),
	createdAt: z.string(),
	updatedAt: z.string().nullable(),
});

const attachmentSchema = z.object({
	id: z.string(),
	ticketId: z.string(),
	filename: z.string(),
	contentType: z.string(),
	size: z.number(),
	uploadedBy: z.string(),
	createdAt: z.string(),
});

const meSchema = z.object({
	id: z.string(),
	role: roleSchema,
	name: z.string().nullable(),
});
const commentListSchema = z.object({
	comments: z.array(commentSchema),
	total: z.number(),
});
const attachmentListSchema = z.object({
	attachments: z.array(attachmentSchema),
	total: z.number(),
});
const roleUpdateSchema = z.object({ id: z.string(), role: roleSchema });
const tagsSchema = z.object({ tags: z.array(z.string()) });
const okSchema = z.object({ ok: z.boolean() });

const activitySchema = z.object({
	id: z.string(),
	type: z.string(),
	actorId: z.string(),
	actorRole: roleSchema,
	ticketId: z.string().nullable(),
	commentId: z.string().nullable(),
	attachmentId: z.string().nullable(),
	userId: z.string().nullable(),
	data: z.record(z.string(), z.unknown()).nullable(),
	createdAt: z.string(),
});
const activityPageSchema = z.object({
	activities: z.array(activitySchema),
	total: z.number(),
	limit: z.number(),
	offset: z.number(),
});

export type Ticket<M extends TicketMetadata = TicketMetadata> = z.infer<
	ReturnType<typeof ticketSchemaFor<M>>
>;
export type Comment = z.infer<typeof commentSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;

function configOf(svc: SvcCtx): ServiceDeskConfig {
	return svc.config as unknown as ServiceDeskConfig;
}
function authOf(svc: SvcCtx) {
	return configOf(svc).auth;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Clamp `limit`/`offset` query strings into a sane pagination window. */
function paginate(query?: { limit?: string; offset?: string }) {
	const limit = Math.min(
		Math.max(Number(query?.limit) || DEFAULT_LIMIT, 1),
		MAX_LIMIT,
	);
	const offset = Math.max(Number(query?.offset) || 0, 0);
	return { limit, offset };
}

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
	castText: boolean,
): Expression<SqlBool> {
	switch (node.type) {
		case "and": {
			const parts = node.nodes.map((n) =>
				ticketFilterExpression(eb, n, castText),
			);
			return parts.length ? eb.and(parts) : ALWAYS_TRUE;
		}
		case "or": {
			const parts = node.nodes.map((n) =>
				ticketFilterExpression(eb, n, castText),
			);
			return parts.length ? eb.or(parts) : ALWAYS_TRUE;
		}
		case "not":
			return eb.not(ticketFilterExpression(eb, node.node, castText));
		case "cond": {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic column ref
			const field = node.field as any;
			const value = node.value;
			// On Postgres, `tags` is jsonb and has no `LIKE` operator; cast the
			// operand to text so substring matching works across all dialects.
			const likeField = castText
				? sql`${eb.ref(field)}::text`
				: (field as Expression<string>);
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
					return eb(likeField, "like", `%${value}%`);
				case "startsWith":
					return eb(likeField, "like", `${value}%`);
				case "endsWith":
					return eb(likeField, "like", `%${value}`);
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
	// A `json`/`jsonb` column comes back already parsed (an array); a text column
	// (or the in-memory serialized value) comes back as a JSON string.
	if (Array.isArray(value)) return value.filter((t) => typeof t === "string");
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
/** Metadata is stored as a JSON object of arbitrary key/value pairs. */
function serializeMetadata(metadata: Record<string, unknown>): string | null {
	const keys = Object.keys(metadata);
	return keys.length ? JSON.stringify(metadata) : null;
}
function parseMetadata(value: unknown): Record<string, unknown> {
	// A `json`/`jsonb` column comes back already parsed (an object); a text
	// column (or the in-memory serialized value) comes back as a JSON string.
	const asObject = (v: unknown): Record<string, unknown> =>
		v && typeof v === "object" && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: {};
	if (typeof value !== "string") return asObject(value);
	if (!value) return {};
	try {
		return asObject(JSON.parse(value));
	} catch {
		return {};
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
/**
 * Validate metadata against the configured Standard Schema (if any); 400 on
 * failure. A configured schema is a guarantee, so this runs against the value
 * that will be stored — `{}` when the caller omits metadata — which makes
 * metadata effectively required unless the schema accepts `{}`.
 */
async function validateMetadata(svc: SvcCtx, metadata: unknown): Promise<void> {
	const schema = configOf(svc).metadataSchema;
	if (!schema) return;
	const result = await schema["~standard"].validate(metadata);
	if (result.issues) {
		const detail = result.issues.map((issue) => issue.message).join(", ");
		throw new APIError("BAD_REQUEST", {
			message: `Invalid metadata: ${detail}`,
		});
	}
}

/** Attach live owner/assignee display names (from better-auth) + tags array to tickets. */
async function enrichTickets<M extends TicketMetadata>(
	svc: SvcCtx,
	tickets: TicketRow[],
): Promise<Ticket<M>[]> {
	const names = await resolveUserNames(
		authOf(svc),
		tickets.flatMap((t) => [t.userId, t.assigneeId]),
	);
	return tickets.map((t) => ({
		...t,
		status: t.status as Ticket["status"],
		tags: parseTags(t.tags),
		metadata: parseMetadata(t.metadata) as M,
		userName: names.get(t.userId)?.name ?? null,
		assigneeName: t.assigneeId ? (names.get(t.assigneeId)?.name ?? null) : null,
	}));
}

async function enrichTicket<M extends TicketMetadata>(
	svc: SvcCtx,
	ticket: TicketRow,
): Promise<Ticket<M>> {
	const [enriched] = await enrichTickets<M>(svc, [ticket]);
	return enriched as Ticket<M>;
}

/** Attach live author display names (from better-auth) to comments. */
async function enrichComments(
	svc: SvcCtx,
	comments: CommentRow[],
): Promise<Comment[]> {
	const names = await resolveUserNames(
		authOf(svc),
		comments.map((c) => c.authorId),
	);
	return comments.map((c) => ({
		...c,
		authorRole: c.authorRole as Comment["authorRole"],
		authorName: names.get(c.authorId)?.name ?? null,
		updatedAt: c.updatedAt ?? null,
	}));
}

type ActivityRow = DB["activities"];

/** Project a stored activity row into its DTO, parsing the JSON `data` column. */
function toActivityDto(row: ActivityRow) {
	return {
		id: row.id,
		type: row.type,
		actorId: row.actorId,
		actorRole: row.actorRole as Role,
		ticketId: row.ticketId ?? null,
		commentId: row.commentId ?? null,
		attachmentId: row.attachmentId ?? null,
		userId: row.userId ?? null,
		data: row.data == null ? null : parseMetadata(row.data),
		createdAt: row.createdAt,
	};
}

/**
 * Loads a ticket by its UUID `id` or its monotonic `number` (an all-digit key)
 * and enforces read access: agents see everything, users only their own. Throws
 * 404/403 as appropriate.
 */
async function getAccessibleTicket(ctx: Ctx["context"], idOrNumber: string) {
	const { serviceCtx: svc, serviceDesk } = ctx;
	const base = svc.db.selectFrom("tickets").selectAll();
	const ticket = await (/^\d+$/.test(idOrNumber)
		? base.where("number", "=", Number(idOrNumber))
		: base.where("id", "=", idOrNumber)
	).executeTakeFirst();
	if (!ticket) {
		throw new APIError("NOT_FOUND", { message: "Ticket not found" });
	}
	if (serviceDesk.role !== "agent" && ticket.userId !== serviceDesk.userId) {
		throw new APIError("FORBIDDEN", { message: "Not your ticket" });
	}
	return ticket;
}

/** Extract request headers from a better-call endpoint context. */
function headersOf(ctx: unknown): Headers {
	const c = ctx as { headers?: Headers; request?: Request };
	return c.headers ?? c.request?.headers ?? new Headers();
}

/**
 * Load a ticket by UUID `id` or monotonic `number` that is owned by `userId`.
 * Throws 404 if it doesn't exist or belongs to someone else. Used by the
 * management endpoints, which scope every operation to a fixed owner.
 */
async function getOwnedTicket(
	svc: SvcCtx,
	userId: string,
	idOrNumber: string,
): Promise<TicketRow> {
	const base = svc.db.selectFrom("tickets").selectAll();
	const ticket = await (/^\d+$/.test(idOrNumber)
		? base.where("number", "=", Number(idOrNumber))
		: base.where("id", "=", idOrNumber)
	).executeTakeFirst();
	if (!ticket || ticket.userId !== userId) {
		throw new APIError("NOT_FOUND", { message: "Ticket not found" });
	}
	return ticket;
}

/** The activity actor for a user id, tagged with their persisted role. */
async function actorForUser(svc: SvcCtx, userId: string): Promise<Actor> {
	const row = await svc.db
		.selectFrom("users")
		.select("role")
		.where("id", "=", userId)
		.executeTakeFirst();
	return { id: userId, role: (row?.role as Role) ?? "user" };
}

/** Validate, insert (with the next ticket number), enrich, and log a new ticket. */
async function insertTicket<M extends TicketMetadata>(
	svc: SvcCtx,
	input: {
		userId: string;
		actor: Actor;
		subject: string;
		description: string;
		tags: string[];
		metadata: Record<string, unknown>;
	},
): Promise<Ticket<M>> {
	validateTags(svc, input.tags);
	await validateMetadata(svc, input.metadata);
	const now = new Date().toISOString();
	// Read the current max and insert atomically so concurrent creates can't
	// hand out the same number.
	const ticket = await svc.db.transaction().execute(async (trx) => {
		const row = await trx
			.selectFrom("tickets")
			.select((eb) => eb.fn.max("number").as("max"))
			.executeTakeFirst();
		const next = Number(row?.max ?? 0) + 1;
		const t = {
			id: crypto.randomUUID(),
			number: next,
			userId: input.userId,
			subject: input.subject,
			description: input.description,
			status: "open",
			assigneeId: null,
			tags: serializeTags(input.tags),
			metadata: serializeMetadata(input.metadata),
			archivedAt: null,
			createdAt: now,
			updatedAt: now,
		};
		await trx.insertInto("tickets").values(t).execute();
		return t;
	});
	svc.logger.info(`Ticket created: ${ticket.id} (#${ticket.number})`);
	const enriched = await enrichTicket<M>(svc, ticket);
	await recordActivity(svc, {
		type: "ticket-created",
		actor: input.actor,
		ticketId: enriched.id,
		ticket: enriched,
	});
	return enriched;
}

/** Force-scoped ticket listing: Lucene filter + pagination, optionally pinned to one owner. */
async function queryTicketList<M extends TicketMetadata>(
	svc: SvcCtx,
	opts: {
		scopeUserId?: string | null;
		q?: string;
		limit: number;
		offset: number;
	},
): Promise<{
	tickets: Ticket<M>[];
	total: number;
	limit: number;
	offset: number;
}> {
	const q = opts.q ?? "";
	const nodes: FilterNode[] = [];
	if (opts.scopeUserId) {
		nodes.push({
			type: "cond",
			field: "userId",
			op: "eq",
			value: opts.scopeUserId,
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
		const castText = svc.db.getExecutor().adapter instanceof PostgresAdapter;
		listQuery = listQuery.where((eb) =>
			ticketFilterExpression(eb, filter, castText),
		);
		countQuery = countQuery.where((eb) =>
			ticketFilterExpression(eb, filter, castText),
		);
	}

	const tickets = await listQuery
		.orderBy("createdAt", "desc")
		.limit(opts.limit)
		.offset(opts.offset)
		.execute();
	const countRow = await countQuery.executeTakeFirst();
	return {
		tickets: await enrichTickets<M>(svc, tickets),
		total: Number(countRow?.count ?? 0),
		limit: opts.limit,
		offset: opts.offset,
	};
}

/**
 * Persist a prepared ticket `data` patch, then record the granular activities
 * implied by the before/after diff (status, assignee, archive, content). A
 * no-op patch just re-enriches the unchanged row.
 */
async function commitTicketUpdate<M extends TicketMetadata>(
	svc: SvcCtx,
	before: TicketRow,
	data: Partial<TicketRow>,
	actor: Actor,
): Promise<Ticket<M>> {
	if (Object.keys(data).length === 0) {
		return await enrichTicket<M>(svc, before);
	}
	data.updatedAt = new Date().toISOString();
	await svc.db
		.updateTable("tickets")
		.set(data)
		.where("id", "=", before.id)
		.execute();
	const updated = await svc.db
		.selectFrom("tickets")
		.selectAll()
		.where("id", "=", before.id)
		.executeTakeFirstOrThrow();
	const enriched = await enrichTicket<M>(svc, updated);

	if (before.status !== updated.status) {
		await recordActivity(svc, {
			type: "ticket-status-changed",
			actor,
			ticketId: enriched.id,
			ticket: enriched,
			from: before.status as TicketStatus,
			to: updated.status as TicketStatus,
		});
	}
	if ((before.assigneeId ?? null) !== (updated.assigneeId ?? null)) {
		await recordActivity(svc, {
			type: "ticket-assigned",
			actor,
			ticketId: enriched.id,
			ticket: enriched,
			from: before.assigneeId ?? null,
			to: updated.assigneeId ?? null,
		});
	}
	const wasArchived = before.archivedAt != null;
	const isArchived = updated.archivedAt != null;
	if (wasArchived !== isArchived) {
		await recordActivity(svc, {
			type: isArchived ? "ticket-archived" : "ticket-unarchived",
			actor,
			ticketId: enriched.id,
			ticket: enriched,
		});
	}
	const changedFields: string[] = [];
	if (before.subject !== updated.subject) changedFields.push("subject");
	if (before.description !== updated.description) {
		changedFields.push("description");
	}
	if (
		JSON.stringify(parseTags(before.tags)) !==
		JSON.stringify(parseTags(updated.tags))
	) {
		changedFields.push("tags");
	}
	if (
		JSON.stringify(parseMetadata(before.metadata)) !==
		JSON.stringify(parseMetadata(updated.metadata))
	) {
		changedFields.push("metadata");
	}
	if (changedFields.length) {
		await recordActivity(svc, {
			type: "ticket-updated",
			actor,
			ticketId: enriched.id,
			ticket: enriched,
			changedFields,
		});
	}
	return enriched;
}

/**
 * Builds all service-desk endpoints. `defineEndpoint` is futonic's pre-bound
 * `createEndpoint` (its service-context middleware already baked in). We wrap it
 * so every handler first authenticates and attaches `serviceDesk` to the
 * context — done in the handler (not `use`) because futonic's baked middleware
 * runs last, so `serviceCtx` is only guaranteed present once the handler runs.
 */
export function createSpindeskEndpoints<
	M extends TicketMetadata = TicketMetadata,
>(defineEndpoint: DefineServiceDeskEndpoint) {
	const ticketSchema = ticketSchemaFor<M>();
	const ticketPageSchema = z.object({
		tickets: z.array(ticketSchema),
		total: z.number(),
		limit: z.number(),
		offset: z.number(),
	});
	// biome-ignore lint/suspicious/noExplicitAny: passthrough over defineEndpoint's generic signature
	const createEndpoint = ((path: any, options: any, handler: any) =>
		defineEndpoint(path, options, async (ctx: unknown) => {
			const context = (ctx as unknown as Ctx).context;
			context.serviceDesk = await resolveIdentity(
				context.serviceCtx,
				headersOf(ctx),
			);
			return handler(ctx);
		})) as unknown as DefineServiceDeskEndpoint;

	/** Current user's service-desk profile — lets the host UI branch on role. */
	const me = createEndpoint(
		"/me",
		{ method: "GET", output: meSchema },
		async (ctx) => {
			const { serviceCtx: svc, serviceDesk } = (ctx as unknown as Ctx).context;
			const names = await resolveUserNames(authOf(svc), [serviceDesk.userId]);
			return {
				id: serviceDesk.userId,
				role: serviceDesk.role,
				name: names.get(serviceDesk.userId)?.name ?? null,
			};
		},
	);

	const createTicket = createEndpoint(
		"/tickets",
		{
			method: "POST",
			body: z.object({
				subject: z.string().min(1),
				description: z.string().min(1),
				tags: z.array(z.string()).optional(),
				metadata: metadataField<M>().optional(),
			}),
			output: ticketSchema,
		},
		async (ctx) => {
			const { serviceCtx: svc, serviceDesk } = (ctx as unknown as Ctx).context;
			return await insertTicket<M>(svc, {
				userId: serviceDesk.userId,
				actor: { id: serviceDesk.userId, role: serviceDesk.role },
				subject: ctx.body.subject,
				description: ctx.body.description,
				tags: ctx.body.tags ?? [],
				metadata: ctx.body.metadata ?? {},
			});
		},
	);

	const listTickets = createEndpoint(
		"/tickets",
		{
			method: "GET",
			query: z.object({
				q: z.string().optional(),
				limit: z.string().optional(),
				offset: z.string().optional(),
			}),
			output: ticketPageSchema,
		},
		async (ctx) => {
			const { serviceCtx: svc, serviceDesk } = (ctx as unknown as Ctx).context;
			const scopeUserId =
				serviceDesk.role === "agent" ? null : serviceDesk.userId;
			const limit = Math.min(
				Math.max(Number(ctx.query?.limit) || DEFAULT_LIMIT, 1),
				MAX_LIMIT,
			);
			const offset = Math.max(Number(ctx.query?.offset) || 0, 0);
			return await queryTicketList<M>(svc, {
				scopeUserId,
				q: ctx.query?.q,
				limit,
				offset,
			});
		},
	);

	const getTicket = createEndpoint(
		"/tickets/:id",
		{ method: "GET", output: ticketSchema },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { id } = ctx.params as { id: string };
			const ticket = await getAccessibleTicket(context, id);
			return await enrichTicket<M>(context.serviceCtx, ticket);
		},
	);

	const updateTicket = createEndpoint(
		"/tickets/:id",
		{
			method: "PATCH",
			body: z.object({
				// Author-editable content.
				subject: z.string().min(1).optional(),
				description: z.string().min(1).optional(),
				tags: z.array(z.string()).optional(),
				metadata: metadataField<M>().optional(),
				archived: z.boolean().optional(),
				// Agent-only workflow fields.
				status: z.enum(TICKET_STATUS).optional(),
				assigneeId: z.string().nullable().optional(),
			}),
			output: ticketSchema,
		},
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc, serviceDesk } = context;
			const { id } = ctx.params as { id: string };
			const ticket = await getAccessibleTicket(context, id);
			const isAgent = serviceDesk.role === "agent";
			const isOwner = ticket.userId === serviceDesk.userId;

			const data: Partial<TicketRow> = {};

			// Author (or agent) may edit content, tags, and archive state.
			const editsContent =
				ctx.body.subject !== undefined ||
				ctx.body.description !== undefined ||
				ctx.body.tags !== undefined ||
				ctx.body.metadata !== undefined ||
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
			if (ctx.body.metadata !== undefined) {
				await validateMetadata(svc, ctx.body.metadata);
				data.metadata = serializeMetadata(ctx.body.metadata);
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
			return await commitTicketUpdate<M>(svc, ticket, data, {
				id: serviceDesk.userId,
				role: serviceDesk.role,
			});
		},
	);

	const listComments = createEndpoint(
		"/tickets/:id/comments",
		{ method: "GET", output: commentListSchema },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc } = context;
			const { id } = ctx.params as { id: string };
			const ticket = await getAccessibleTicket(context, id); // authorize
			// Flat, chronological list; the client assembles the reply tree
			// from each comment's `parentId`.
			const comments = await svc.db
				.selectFrom("comments")
				.selectAll()
				.where("ticketId", "=", ticket.id)
				.orderBy("createdAt", "asc")
				.execute();
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
			body: z.object({
				body: z.string().min(1),
				parentId: z.string().nullable().optional(),
			}),
			output: commentSchema,
		},
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc, serviceDesk } = context;
			const { id } = ctx.params as { id: string };
			const ticket = await getAccessibleTicket(context, id); // authorize

			// A reply must target an existing comment on the same ticket.
			const parentId = ctx.body.parentId ?? null;
			if (parentId) {
				const parent = await svc.db
					.selectFrom("comments")
					.selectAll()
					.where("id", "=", parentId)
					.executeTakeFirst();
				if (!parent || parent.ticketId !== ticket.id) {
					throw new APIError("BAD_REQUEST", {
						message: "Invalid parent comment",
					});
				}
			}

			const now = new Date().toISOString();
			const comment = {
				id: crypto.randomUUID(),
				ticketId: ticket.id,
				parentId,
				authorId: serviceDesk.userId,
				authorRole: serviceDesk.role,
				body: ctx.body.body,
				createdAt: now,
				updatedAt: null,
			};
			await svc.db.insertInto("comments").values(comment).execute();
			// Bump ticket activity timestamp.
			await svc.db
				.updateTable("tickets")
				.set({ updatedAt: now })
				.where("id", "=", ticket.id)
				.execute();
			const [enriched] = await enrichComments(svc, [comment]);
			await recordActivity(svc, {
				type: "comment-created",
				actor: { id: serviceDesk.userId, role: serviceDesk.role },
				ticketId: ticket.id,
				commentId: comment.id,
				comment: enriched as Comment,
			});
			return enriched as Comment;
		},
	);

	/** Load a comment on an accessible ticket, enforcing author-or-agent access. */
	async function getEditableComment(
		context: Ctx["context"],
		idOrNumber: string,
		commentId: string,
	) {
		const { serviceCtx: svc, serviceDesk } = context;
		const ticket = await getAccessibleTicket(context, idOrNumber);
		const comment = await svc.db
			.selectFrom("comments")
			.selectAll()
			.where("id", "=", commentId)
			.executeTakeFirst();
		if (!comment || comment.ticketId !== ticket.id) {
			throw new APIError("NOT_FOUND", { message: "Comment not found" });
		}
		const isAgent = serviceDesk.role === "agent";
		const isAuthor = comment.authorId === serviceDesk.userId;
		if (!isAgent && !isAuthor) {
			throw new APIError("FORBIDDEN", { message: "Not your comment" });
		}
		return { ticket, comment };
	}

	const editComment = createEndpoint(
		"/tickets/:id/comments/:commentId",
		{
			method: "PATCH",
			body: z.object({ body: z.string().min(1) }),
			output: commentSchema,
		},
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc, serviceDesk } = context;
			const { id, commentId } = ctx.params as {
				id: string;
				commentId: string;
			};
			const { ticket } = await getEditableComment(context, id, commentId);
			await svc.db
				.updateTable("comments")
				.set({ body: ctx.body.body, updatedAt: new Date().toISOString() })
				.where("id", "=", commentId)
				.execute();
			const updated = await svc.db
				.selectFrom("comments")
				.selectAll()
				.where("id", "=", commentId)
				.executeTakeFirstOrThrow();
			const [enriched] = await enrichComments(svc, [updated]);
			await recordActivity(svc, {
				type: "comment-edited",
				actor: { id: serviceDesk.userId, role: serviceDesk.role },
				ticketId: ticket.id,
				commentId,
				comment: enriched as Comment,
			});
			return enriched as Comment;
		},
	);

	const deleteComment = createEndpoint(
		"/tickets/:id/comments/:commentId",
		{ method: "DELETE", output: okSchema },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc, serviceDesk } = context;
			const { id, commentId } = ctx.params as {
				id: string;
				commentId: string;
			};
			const { ticket } = await getEditableComment(context, id, commentId);
			await svc.db.deleteFrom("comments").where("id", "=", commentId).execute();
			await recordActivity(svc, {
				type: "comment-deleted",
				actor: { id: serviceDesk.userId, role: serviceDesk.role },
				ticketId: ticket.id,
				commentId,
			});
			return { ok: true };
		},
	);

	/** Agent-only: promote/demote another user's role (lazily provisions row). */
	const setUserRole = createEndpoint(
		"/users/:id/role",
		{
			method: "PATCH",
			body: z.object({ role: z.enum(["user", "agent"]) }),
			output: roleUpdateSchema,
			metadata: {
				openapi: {
					summary: "Set a user's role",
					description:
						"Promote or demote another user's role. Requires the caller to hold the **agent** role; regular users receive `403 Forbidden`.",
					security: [{ sessionCookie: [] }],
					responses: {
						"403": {
							description: "Forbidden. The authenticated user is not an agent.",
						},
					},
				},
			},
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
			await recordActivity(svc, {
				type: "user-role-changed",
				actor: { id: serviceDesk.userId, role: serviceDesk.role },
				userId: id,
				from: (existing?.role as Role | undefined) ?? null,
				to: role,
			});
			return { id, role };
		},
	);

	/**
	 * Management-only: promote a user to agent by id or email, authorized by the
	 * management API key rather than a session. Uses the raw `defineEndpoint`
	 * (not the session-authed wrapper) so callers need no better-auth session.
	 */
	const promoteAgent = defineEndpoint(
		"/management/agents",
		{
			method: "POST",
			body: z
				.object({
					userId: z.string().min(1).optional(),
					email: z.string().min(1).optional(),
				})
				.refine((v) => !!v.userId || !!v.email, {
					message: "userId or email is required",
				}),
			output: roleUpdateSchema,
			metadata: {
				openapi: {
					summary: "Promote a user to agent",
					description:
						"Promote a user to the **agent** role by id or email. Authorized by the management API key header, not a better-auth session.",
					security: [{ managementApiKey: [] }],
				},
			},
		},
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			requireManagementKey(configOf(svc), headersOf(ctx));
			const { userId, email } = ctx.body as {
				userId?: string;
				email?: string;
			};

			let id = userId ?? null;
			if (!id && email) {
				id = await resolveUserIdByEmail(authOf(svc), email);
				if (!id) {
					throw new APIError("NOT_FOUND", {
						message: "No user found for that email",
					});
				}
			}
			if (!id) {
				throw new APIError("BAD_REQUEST", {
					message: "userId or email is required",
				});
			}

			const existing = await svc.db
				.selectFrom("users")
				.selectAll()
				.where("id", "=", id)
				.executeTakeFirst();
			if (existing) {
				await svc.db
					.updateTable("users")
					.set({ role: "agent" })
					.where("id", "=", id)
					.execute();
			} else {
				await svc.db
					.insertInto("users")
					.values({ id, role: "agent", createdAt: new Date().toISOString() })
					.execute();
			}
			await recordActivity(svc, {
				type: "user-role-changed",
				actor: { id: "management-api", role: "agent" },
				userId: id,
				from: (existing?.role as Role | undefined) ?? null,
				to: "agent",
			});
			return { id, role: "agent" as Role };
		},
	);

	/**
	 * Management-only ticket CRUD on behalf of a specific user, authorized by the
	 * management API key rather than a session. Every operation is scoped to the
	 * `:userId` path segment: created tickets are owned by that user, and reads,
	 * updates, and deletes only touch that user's tickets. Uses the raw
	 * `defineEndpoint` (not the session-authed wrapper).
	 */
	const managementCreateTicket = defineEndpoint(
		"/management/users/:userId/tickets",
		{
			method: "POST",
			body: z.object({
				subject: z.string().min(1),
				description: z.string().min(1),
				tags: z.array(z.string()).optional(),
				metadata: metadataField<M>().optional(),
			}),
			output: ticketSchema,
			metadata: {
				openapi: {
					summary: "Create a ticket on behalf of a user",
					description:
						"Create a ticket owned by the given user. Authorized by the management API key header, not a better-auth session.",
					security: [{ managementApiKey: [] }],
				},
			},
		},
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			requireManagementKey(configOf(svc), headersOf(ctx));
			const { userId } = ctx.params as { userId: string };
			return await insertTicket<M>(svc, {
				userId,
				actor: await actorForUser(svc, userId),
				subject: ctx.body.subject,
				description: ctx.body.description,
				tags: ctx.body.tags ?? [],
				metadata: ctx.body.metadata ?? {},
			});
		},
	);

	const managementListTickets = defineEndpoint(
		"/management/users/:userId/tickets",
		{
			method: "GET",
			query: z.object({
				q: z.string().optional(),
				limit: z.string().optional(),
				offset: z.string().optional(),
			}),
			output: ticketPageSchema,
			metadata: {
				openapi: {
					summary: "List a user's tickets",
					description:
						"List tickets owned by the given user. Authorized by the management API key header, not a better-auth session.",
					security: [{ managementApiKey: [] }],
				},
			},
		},
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			requireManagementKey(configOf(svc), headersOf(ctx));
			const { userId } = ctx.params as { userId: string };
			const { limit, offset } = paginate(ctx.query);
			return await queryTicketList<M>(svc, {
				scopeUserId: userId,
				q: ctx.query?.q,
				limit,
				offset,
			});
		},
	);

	const managementGetTicket = defineEndpoint(
		"/management/users/:userId/tickets/:id",
		{
			method: "GET",
			output: ticketSchema,
			metadata: {
				openapi: {
					summary: "Get a user's ticket",
					description:
						"Fetch one of the given user's tickets by id or number. Authorized by the management API key header, not a better-auth session.",
					security: [{ managementApiKey: [] }],
				},
			},
		},
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			requireManagementKey(configOf(svc), headersOf(ctx));
			const { userId, id } = ctx.params as { userId: string; id: string };
			const ticket = await getOwnedTicket(svc, userId, id);
			return await enrichTicket<M>(svc, ticket);
		},
	);

	const managementUpdateTicket = defineEndpoint(
		"/management/users/:userId/tickets/:id",
		{
			method: "PATCH",
			body: z.object({
				subject: z.string().min(1).optional(),
				description: z.string().min(1).optional(),
				tags: z.array(z.string()).optional(),
				metadata: metadataField<M>().optional(),
				archived: z.boolean().optional(),
				status: z.enum(TICKET_STATUS).optional(),
				assigneeId: z.string().nullable().optional(),
			}),
			output: ticketSchema,
			metadata: {
				openapi: {
					summary: "Update a user's ticket",
					description:
						"Update one of the given user's tickets. Unlike the session API, this applies every field including the agent-only workflow fields. Authorized by the management API key header, not a better-auth session.",
					security: [{ managementApiKey: [] }],
				},
			},
		},
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			requireManagementKey(configOf(svc), headersOf(ctx));
			const { userId, id } = ctx.params as { userId: string; id: string };
			const ticket = await getOwnedTicket(svc, userId, id);

			const data: Partial<TicketRow> = {};
			if (ctx.body.subject !== undefined) data.subject = ctx.body.subject;
			if (ctx.body.description !== undefined) {
				data.description = ctx.body.description;
			}
			if (ctx.body.tags !== undefined) {
				validateTags(svc, ctx.body.tags);
				data.tags = serializeTags(ctx.body.tags);
			}
			if (ctx.body.metadata !== undefined) {
				await validateMetadata(svc, ctx.body.metadata);
				data.metadata = serializeMetadata(ctx.body.metadata);
			}
			if (ctx.body.archived !== undefined) {
				data.archivedAt = ctx.body.archived ? new Date().toISOString() : null;
			}
			if (ctx.body.status !== undefined) data.status = ctx.body.status;
			if (ctx.body.assigneeId !== undefined) {
				data.assigneeId = ctx.body.assigneeId;
			}
			return await commitTicketUpdate<M>(
				svc,
				ticket,
				data,
				await actorForUser(svc, userId),
			);
		},
	);

	const managementDeleteTicket = defineEndpoint(
		"/management/users/:userId/tickets/:id",
		{
			method: "DELETE",
			output: okSchema,
			metadata: {
				openapi: {
					summary: "Delete a user's ticket",
					description:
						"Permanently delete one of the given user's tickets, along with its comments and attachments. Authorized by the management API key header, not a better-auth session.",
					security: [{ managementApiKey: [] }],
				},
			},
		},
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			requireManagementKey(configOf(svc), headersOf(ctx));
			const { userId, id } = ctx.params as { userId: string; id: string };
			const ticket = await getOwnedTicket(svc, userId, id);
			await svc.db.transaction().execute(async (trx) => {
				await trx
					.deleteFrom("attachments")
					.where("ticketId", "=", ticket.id)
					.execute();
				await trx
					.deleteFrom("comments")
					.where("ticketId", "=", ticket.id)
					.execute();
				await trx.deleteFrom("tickets").where("id", "=", ticket.id).execute();
			});
			await recordActivity(svc, {
				type: "ticket-deleted",
				actor: await actorForUser(svc, userId),
				ticketId: ticket.id,
			});
			return { ok: true };
		},
	);

	/** Available tag vocabulary, for the host UI's tag picker. */
	const listTags = createEndpoint(
		"/tags",
		{ method: "GET", output: tagsSchema },
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
		{
			method: "POST",
			disableBody: true,
			requireRequest: true,
			output: attachmentSchema,
		},
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc, serviceDesk } = context;
			const { id } = ctx.params as { id: string };
			const ticket = await getAccessibleTicket(context, id);

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
				ticketId: ticket.id,
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
			await recordActivity(svc, {
				type: "attachment-created",
				actor: { id: serviceDesk.userId, role: serviceDesk.role },
				ticketId: ticket.id,
				attachmentId: meta.id,
				attachment: meta,
			});
			return meta;
		},
	);

	const listAttachments = createEndpoint(
		"/tickets/:id/attachments",
		{ method: "GET", output: attachmentListSchema },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc } = context;
			const { id } = ctx.params as { id: string };
			const ticket = await getAccessibleTicket(context, id);
			// Metadata only — never load the blobs to list them.
			const rows = await svc.db
				.selectFrom("attachments")
				.select([...ATTACHMENT_META])
				.where("ticketId", "=", ticket.id)
				.orderBy("createdAt", "asc")
				.execute();
			return { attachments: rows, total: rows.length };
		},
	);

	const downloadAttachment = createEndpoint(
		"/tickets/:id/attachments/:attId",
		{ method: "GET" },
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc } = context;
			const { id, attId } = ctx.params as { id: string; attId: string };
			const ticket = await getAccessibleTicket(context, id);
			const row = await svc.db
				.selectFrom("attachments")
				.selectAll()
				.where("id", "=", attId)
				.executeTakeFirst();
			if (!row || row.ticketId !== ticket.id) {
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
		{ method: "DELETE", output: okSchema },
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
			if (!row || row.ticketId !== ticket.id) {
				throw new APIError("NOT_FOUND", { message: "Attachment not found" });
			}
			const isAgent = serviceDesk.role === "agent";
			const isOwner = ticket.userId === serviceDesk.userId;
			if (!isAgent && !isOwner) {
				throw new APIError("FORBIDDEN", { message: "Not allowed" });
			}
			await svc.db.deleteFrom("attachments").where("id", "=", attId).execute();
			await recordActivity(svc, {
				type: "attachment-deleted",
				actor: { id: serviceDesk.userId, role: serviceDesk.role },
				ticketId: ticket.id,
				attachmentId: attId,
			});
			return { ok: true };
		},
	);

	const listActivities = createEndpoint(
		"/activities",
		{
			method: "GET",
			query: z.object({
				limit: z.string().optional(),
				offset: z.string().optional(),
				type: z.string().optional(),
				ticketId: z.string().optional(),
			}),
			output: activityPageSchema,
		},
		async (ctx) => {
			const { serviceCtx: svc, serviceDesk } = (ctx as unknown as Ctx).context;
			const { limit, offset } = paginate(ctx.query);
			const isAgent = serviceDesk.role === "agent";
			const type = ctx.query?.type;
			const ticketId = ctx.query?.ticketId;

			const conditions = (eb: ExpressionBuilder<DB, "activities">) => {
				const clauses: Expression<SqlBool>[] = [];
				if (!isAgent) {
					// A user sees activities on tickets they own plus their own
					// role changes; agents see everything.
					clauses.push(
						eb.or([
							eb(
								"ticketId",
								"in",
								eb
									.selectFrom("tickets")
									.select("id")
									.where("userId", "=", serviceDesk.userId),
							),
							eb("userId", "=", serviceDesk.userId),
						]),
					);
				}
				if (type) clauses.push(eb("type", "=", type));
				if (ticketId) clauses.push(eb("ticketId", "=", ticketId));
				return clauses.length ? eb.and(clauses) : ALWAYS_TRUE;
			};

			const rows = await svc.db
				.selectFrom("activities")
				.selectAll()
				.where(conditions)
				.orderBy("createdAt", "desc")
				.limit(limit)
				.offset(offset)
				.execute();
			const countRow = await svc.db
				.selectFrom("activities")
				.select((eb) => eb.fn.countAll().as("count"))
				.where(conditions)
				.executeTakeFirst();
			return {
				activities: rows.map(toActivityDto),
				total: Number(countRow?.count ?? 0),
				limit,
				offset,
			};
		},
	);

	const listTicketActivities = createEndpoint(
		"/tickets/:id/activities",
		{
			method: "GET",
			query: z.object({
				limit: z.string().optional(),
				offset: z.string().optional(),
				type: z.string().optional(),
			}),
			output: activityPageSchema,
		},
		async (ctx) => {
			const context = (ctx as unknown as Ctx).context;
			const { serviceCtx: svc } = context;
			const { id } = ctx.params as { id: string };
			const ticket = await getAccessibleTicket(context, id);
			const { limit, offset } = paginate(ctx.query);
			const type = ctx.query?.type;

			let list = svc.db
				.selectFrom("activities")
				.selectAll()
				.where("ticketId", "=", ticket.id);
			let count = svc.db
				.selectFrom("activities")
				.select((eb) => eb.fn.countAll().as("count"))
				.where("ticketId", "=", ticket.id);
			if (type) {
				list = list.where("type", "=", type);
				count = count.where("type", "=", type);
			}
			const rows = await list
				.orderBy("createdAt", "desc")
				.limit(limit)
				.offset(offset)
				.execute();
			const countRow = await count.executeTakeFirst();
			return {
				activities: rows.map(toActivityDto),
				total: Number(countRow?.count ?? 0),
				limit,
				offset,
			};
		},
	);

	return {
		me: me,
		listTags: listTags,
		createTicket: createTicket,
		listTickets: listTickets,
		getTicket: getTicket,
		updateTicket: updateTicket,
		listComments: listComments,
		addComment: addComment,
		editComment: editComment,
		deleteComment: deleteComment,
		setUserRole: setUserRole,
		promoteAgent: promoteAgent,
		managementCreateTicket: managementCreateTicket,
		managementListTickets: managementListTickets,
		managementGetTicket: managementGetTicket,
		managementUpdateTicket: managementUpdateTicket,
		managementDeleteTicket: managementDeleteTicket,
		uploadAttachment: uploadAttachment,
		listAttachments: listAttachments,
		downloadAttachment: downloadAttachment,
		deleteAttachment: deleteAttachment,
		listActivities: listActivities,
		listTicketActivities: listTicketActivities,
	};
}
