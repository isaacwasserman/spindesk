import { createAuthClient } from "better-auth/react";

/** better-auth browser client. Talks to /api/auth on the same origin. */
export const authClient = createAuthClient({
	baseURL: window.location.origin,
});

const BASE = "/api/servicedesk";

async function sd<T = any>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(BASE + path, {
		credentials: "include",
		headers: init?.body ? { "content-type": "application/json" } : undefined,
		...init,
	});
	const data = (await res.json().catch(() => ({}))) as any;
	if (!res.ok) {
		throw new Error(data?.message || data?.error || res.statusText);
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
	me: () => sd<{ id: string; role: Role; name: string | null }>("/me"),
	tags: () => sd<{ tags: string[] }>("/tags"),
	listTickets: (query: TicketQuery = {}) => {
		const p = new URLSearchParams();
		if (query.q) p.set("q", query.q);
		if (query.limit != null) p.set("limit", String(query.limit));
		if (query.offset != null) p.set("offset", String(query.offset));
		const qs = p.toString();
		return sd<TicketPage>(`/tickets${qs ? `?${qs}` : ""}`);
	},
	createTicket: (body: {
		subject: string;
		description: string;
		tags?: string[];
	}) => sd<Ticket>("/tickets", { method: "POST", body: JSON.stringify(body) }),
	getTicket: (id: string) => sd<Ticket>(`/tickets/${id}`),
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
	) =>
		sd<Ticket>(`/tickets/${id}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	listComments: (id: string) =>
		sd<{ comments: Comment[]; total: number }>(`/tickets/${id}/comments`),
	addComment: (id: string, body: string, parentId?: string | null) =>
		sd<Comment>(`/tickets/${id}/comments`, {
			method: "POST",
			body: JSON.stringify({ body, parentId: parentId ?? null }),
		}),
	setRole: (id: string, role: Role) =>
		sd<{ id: string; role: Role }>(`/users/${id}/role`, {
			method: "PATCH",
			body: JSON.stringify({ role }),
		}),
	// Attachments
	listAttachments: (id: string) =>
		sd<{ attachments: Attachment[]; total: number }>(
			`/tickets/${id}/attachments`,
		),
	uploadAttachment: (id: string, file: File) =>
		sd<Attachment>(`/tickets/${id}/attachments`, {
			method: "POST",
			body: file, // streamed as the raw request body
			headers: {
				"x-filename": file.name,
				"content-type": file.type || "application/octet-stream",
			},
		}),
	deleteAttachment: (id: string, attId: string) =>
		sd<{ ok: boolean }>(`/tickets/${id}/attachments/${attId}`, {
			method: "DELETE",
		}),
	downloadUrl: (id: string, attId: string) =>
		`${BASE}/tickets/${id}/attachments/${attId}`,
};
