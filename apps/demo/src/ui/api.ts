import { createSpindeskClient } from "@spindesk/core/client";
import { createAuthClient } from "better-auth/react";

/** better-auth browser client. Talks to /api/auth on the same origin. */
export const authClient = createAuthClient({
	baseURL: window.location.origin,
});

const BASE = `${window.location.origin}/api/servicedesk`;

/** Type-safe futonic client bound to the mounted service-desk router. */
const client = createSpindeskClient({ baseURL: BASE, credentials: "include" });

/** Unwrap a better-fetch `{ data, error }` result, throwing the server message. */
async function unwrap<T>(
	// biome-ignore lint/suspicious/noExplicitAny: better-fetch result union
	promise: Promise<any>,
): Promise<T> {
	const { data, error } = await promise;
	if (error) {
		throw new Error(error.message || error.statusText || "Request failed");
	}
	return data as T;
}

export type Role = "user" | "agent";
export type TicketStatus = "open" | "pending" | "resolved" | "closed";

export interface Ticket {
	id: string;
	userId: string;
	userName: string | null;
	subject: string;
	description: string;
	status: TicketStatus;
	assigneeId: string | null;
	assigneeName: string | null;
	tags: string[];
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Attachment {
	id: string;
	ticketId: string;
	filename: string;
	contentType: string;
	size: number;
	uploadedBy: string;
	createdAt: string;
}

export interface TicketPage {
	tickets: Ticket[];
	total: number;
	limit: number;
	offset: number;
}

export interface TicketQuery {
	q?: string;
	limit?: number;
	offset?: number;
}

export interface Comment {
	id: string;
	ticketId: string;
	parentId: string | null;
	authorId: string;
	authorName: string | null;
	authorRole: Role;
	body: string;
	createdAt: string;
}

/** Typed wrapper over the service-desk endpoints. */
export const api = {
	me: () =>
		unwrap<{ id: string; role: Role; name: string | null }>(client("/me")),
	tags: () => unwrap<{ tags: string[] }>(client("/tags")),
	listTickets: (query: TicketQuery = {}) => {
		const q: Record<string, string> = {};
		if (query.q) q.q = query.q;
		if (query.limit != null) q.limit = String(query.limit);
		if (query.offset != null) q.offset = String(query.offset);
		return unwrap<TicketPage>(client("/tickets", { query: q }));
	},
	createTicket: (body: {
		subject: string;
		description: string;
		tags?: string[];
	}) => unwrap<Ticket>(client("@post/tickets", { body })),
	getTicket: (id: string) =>
		unwrap<Ticket>(client("/tickets/:id", { params: { id } })),
	updateTicket: (
		id: string,
		body: {
			subject?: string;
			description?: string;
			tags?: string[];
			archived?: boolean;
			status?: TicketStatus;
			assigneeId?: string | null;
		},
	) => unwrap<Ticket>(client("@patch/tickets/:id", { params: { id }, body })),
	listComments: (id: string) =>
		unwrap<{ comments: Comment[]; total: number }>(
			client("/tickets/:id/comments", { params: { id } }),
		),
	addComment: (id: string, body: string, parentId?: string | null) =>
		unwrap<Comment>(
			client("@post/tickets/:id/comments", {
				params: { id },
				body: { body, parentId: parentId ?? null },
			}),
		),
	setRole: (id: string, role: Role) =>
		unwrap<{ id: string; role: Role }>(
			client("@patch/users/:id/role", { params: { id }, body: { role } }),
		),
	// Attachments
	listAttachments: (id: string) =>
		unwrap<{ attachments: Attachment[]; total: number }>(
			client("/tickets/:id/attachments", { params: { id } }),
		),
	uploadAttachment: (id: string, file: File) =>
		unwrap<Attachment>(
			// The endpoint sets `disableBody`, so its inferred body type is
			// `undefined`; the file is streamed as the raw request body.
			client("@post/tickets/:id/attachments", {
				params: { id },
				// biome-ignore lint/suspicious/noExplicitAny: raw streamed body
				body: file as any,
				headers: {
					"x-filename": file.name,
					"content-type": file.type || "application/octet-stream",
				},
			}),
		),
	deleteAttachment: (id: string, attId: string) =>
		unwrap<{ ok: boolean }>(
			client("@delete/tickets/:id/attachments/:attId", {
				params: { id, attId },
			}),
		),
	downloadUrl: (id: string, attId: string) =>
		`${BASE}/tickets/${id}/attachments/${attId}`,
};
