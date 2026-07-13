import { createSpindeskClient } from "@spindesk/core/client";
import { createAuthClient } from "better-auth/react";

/** better-auth browser client. Talks to /api/auth on the same origin. */
export const authClient = createAuthClient({
	baseURL: window.location.origin,
});

const BASE = `${window.location.origin}/api/servicedesk`;

/**
 * Type-safe service-desk client. `throw: true` means each `client("@post/…")`
 * call returns the response payload directly and throws on error.
 */
export const client = createSpindeskClient({
	baseURL: BASE,
	credentials: "include",
	throw: true,
});

/** Direct download URL for an attachment (streamed straight from the server). */
export const downloadUrl = (ticketId: string, attId: string) =>
	`${BASE}/tickets/${ticketId}/attachments/${attId}`;

/**
 * Read calls, used only to infer the response DTOs from the endpoints — a
 * server schema change surfaces here (and at every call site) as a type error.
 */
const reads = {
	me: () => client("/me"),
	ticket: (id: string) => client("/tickets/:id", { params: { id } }),
	comments: (id: string) => client("/tickets/:id/comments", { params: { id } }),
	attachments: (id: string) =>
		client("/tickets/:id/attachments", { params: { id } }),
};
export type Role = Awaited<ReturnType<typeof reads.me>>["role"];
export type Ticket = Awaited<ReturnType<typeof reads.ticket>>;
export type TicketStatus = Ticket["status"];
export type Comment = Awaited<
	ReturnType<typeof reads.comments>
>["comments"][number];
export type Attachment = Awaited<
	ReturnType<typeof reads.attachments>
>["attachments"][number];
