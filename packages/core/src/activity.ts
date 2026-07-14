import type { Attachment, Comment, Ticket } from "./endpoints.js";
import type { Role, ServiceDeskConfig, SvcCtx, TicketStatus } from "./types.js";

/** Who performed an activity. */
export type Actor = { id: string; role: Role };

/** Fields present on every activity, stamped by `recordActivity`. */
type ActivityMeta = { id: string; actor: Actor; createdAt: string };

/**
 * A ticketing activity. Discriminated on `type`; each variant declares exactly
 * the ids and payload relevant to it (no ticket id on `user-role-changed`, etc).
 */
export type SpindeskActivity = ActivityMeta &
	(
		| { type: "ticket-created"; ticketId: string; ticket: Ticket }
		| {
				type: "ticket-updated";
				ticketId: string;
				ticket: Ticket;
				changedFields: string[];
		  }
		| {
				type: "ticket-status-changed";
				ticketId: string;
				ticket: Ticket;
				from: TicketStatus;
				to: TicketStatus;
		  }
		| {
				type: "ticket-assigned";
				ticketId: string;
				ticket: Ticket;
				from: string | null;
				to: string | null;
		  }
		| { type: "ticket-archived"; ticketId: string; ticket: Ticket }
		| { type: "ticket-unarchived"; ticketId: string; ticket: Ticket }
		| { type: "ticket-deleted"; ticketId: string }
		| {
				type: "comment-created";
				ticketId: string;
				commentId: string;
				comment: Comment;
		  }
		| {
				type: "comment-edited";
				ticketId: string;
				commentId: string;
				comment: Comment;
		  }
		| { type: "comment-deleted"; ticketId: string; commentId: string }
		| {
				type: "attachment-created";
				ticketId: string;
				attachmentId: string;
				attachment: Attachment;
		  }
		| { type: "attachment-deleted"; ticketId: string; attachmentId: string }
		| {
				type: "user-role-changed";
				userId: string;
				from: Role | null;
				to: Role;
		  }
	);

export type SpindeskActivityType = SpindeskActivity["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/** What a handler builds; `recordActivity` stamps `id`/`createdAt`. */
export type SpindeskActivityInput = DistributiveOmit<
	SpindeskActivity,
	"id" | "createdAt"
>;

/**
 * Host-supplied hook invoked for every activity. Receives the activity and the
 * service context (`db`/`config`/`logger`). Errors are swallowed by
 * `recordActivity`, so a failing hook never breaks the originating request.
 */
export type OnActivity = (
	activity: SpindeskActivity,
	context: SvcCtx,
) => Promise<void>;

/**
 * Persist an activity to the denormalized `activities` table, then invoke the
 * host's `onActivity` hook (if configured). Persistence happens regardless of
 * whether a hook is set. Hook errors are logged, not thrown.
 */
export async function recordActivity(
	svc: SvcCtx,
	input: SpindeskActivityInput,
): Promise<void> {
	const activity = {
		...input,
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
	} as SpindeskActivity;

	const { id, type, actor, createdAt, ...rest } = activity;
	const { ticketId, commentId, attachmentId, userId, ...data } = rest as {
		ticketId?: string;
		commentId?: string;
		attachmentId?: string;
		userId?: string;
	} & Record<string, unknown>;

	await svc.db
		.insertInto("activities")
		.values({
			id,
			type,
			actorId: actor.id,
			actorRole: actor.role,
			ticketId: ticketId ?? null,
			commentId: commentId ?? null,
			attachmentId: attachmentId ?? null,
			userId: userId ?? null,
			data: Object.keys(data).length ? JSON.stringify(data) : null,
			createdAt,
		})
		.execute();

	const onActivity = (svc.config as unknown as ServiceDeskConfig).onActivity;
	if (!onActivity) return;
	try {
		await onActivity(activity, svc);
	} catch (err) {
		svc.logger.error(`onActivity hook failed for ${type}: ${String(err)}`);
	}
}
