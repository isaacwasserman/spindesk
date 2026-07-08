import type { KyselyFromServiceDBSchema, ServiceContext } from "futonic";
import type { ServiceDeskSchema } from "./schema";

export type Role = "user" | "agent";
export const TICKET_STATUS = ["open", "pending", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUS)[number];

/** A better-auth user row (subset the service reads for display). */
export interface AuthUser {
	id: string;
	name?: string | null;
	email?: string | null;
}

/**
 * The slice of a better-auth instance the service depends on. The host passes
 * a real better-auth instance; we need server-side session resolution plus the
 * DB adapter (`$context.adapter`) to read display names from the `user` table.
 */
export interface AuthLike {
	api: {
		getSession(opts: {
			headers: Headers;
		}): Promise<{ user: { id: string; email?: string | null } } | null>;
	};
	$context: Promise<{
		adapter: {
			findMany<T>(args: {
				model: string;
				where?: {
					field: string;
					value: unknown;
					operator?: string;
				}[];
				select?: string[];
			}): Promise<T[]>;
		};
	}>;
}

/**
 * Runtime configuration the host supplies via `servicedesk({ database, config })`.
 * It surfaces on `serviceCtx.config`. Declared as a type alias (not an
 * interface) so it satisfies futonic's `Record<string, unknown>` config bound.
 */
export type ServiceDeskConfig = {
	/** better-auth instance used to authenticate incoming requests. */
	auth: AuthLike;
	/** better-auth user ids seeded with the "agent" role on first sight. */
	agentUserIds?: string[];
	/** better-auth user emails seeded with the "agent" role on first sight. */
	agentEmails?: string[];
	/** Allowed tag vocabulary; ticket tags are validated against this. */
	availableTags?: string[];
	/** Max attachment size in bytes (default 5 MiB). */
	maxAttachmentBytes?: number;
};

/** Default attachment size cap: 5 MiB. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * ServiceContext scoped to this service. futonic's context now carries a typed
 * Kysely instance (`db`), the validated `config`, and a `logger`.
 */
export type SvcCtx = ServiceContext<
	ServiceDeskConfig,
	KyselyFromServiceDBSchema<ServiceDeskSchema>
>;

/** Identity resolved by the auth middleware for each request. */
export interface ServiceDeskIdentity {
	userId: string;
	role: Role;
}

/**
 * Narrowed better-call handler context. The service middleware injects
 * `serviceCtx`; our auth middleware injects `serviceDesk`.
 */
export type Ctx = {
	context: {
		serviceCtx: SvcCtx;
		serviceDesk: ServiceDeskIdentity;
	};
};
