import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
	DefineEndpoint,
	KyselyFromServiceDBSchema,
	ServiceContext,
} from "futonic";
import type { OnActivity } from "./activity.js";
import type { ServiceDeskSchema } from "./schema.js";

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
	/**
	 * Shared secret that authorizes management-only endpoints (e.g. promoting a
	 * user to agent by id or email) without a better-auth session. Callers pass
	 * it as an `Authorization: Bearer <key>` token.
	 */
	managementApiKey?: string;
	/** Allowed tag vocabulary; ticket tags are validated against this. */
	availableTags?: string[];
	/**
	 * Optional Standard Schema for ticket `metadata`. When supplied, `metadata`
	 * on create/update is validated against it at runtime (400 on failure), and
	 * `createSpindesk` infers the metadata type from it — so the type flows
	 * end-to-end without an explicit type argument. Omit it to keep metadata an
	 * unvalidated open record.
	 */
	metadataSchema?: StandardSchemaV1;
	/** Max attachment size in bytes (default 5 MiB). */
	maxAttachmentBytes?: number;
	/**
	 * Called for every ticketing activity after it's persisted to the activity
	 * log. Lets the host run its own processing (notifications, mirroring, ...).
	 * Errors are logged and swallowed — a failing hook never breaks the request.
	 */
	onActivity?: OnActivity;
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

/**
 * futonic's pre-bound `createEndpoint`, specialized to this service. It bakes
 * the service-context middleware into every endpoint, so handlers read a typed
 * `ctx.context.serviceCtx`.
 */
export type DefineServiceDeskEndpoint = DefineEndpoint<
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
