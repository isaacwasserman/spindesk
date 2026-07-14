import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
	type HandlerOptions,
	type SecurityScheme,
	createFutonicServiceConstructor,
	defineService,
} from "futonic";
import { z } from "zod";
import type { OnActivity } from "./activity.js";
import { type TicketMetadata, createSpindeskEndpoints } from "./endpoints.js";
import { serviceDeskSchema } from "./schema.js";
import type { AuthLike } from "./types.js";

export { IMPERSONATION_HEADER } from "./auth-middleware.js";
export type { Role } from "./types.js";
export type { Ticket, TicketMetadata } from "./endpoints.js";
export type {
	Actor,
	OnActivity,
	SpindeskActivity,
	SpindeskActivityType,
} from "./activity.js";

// Re-export the type surface consumers must name (via `@spindesk/core`) to stay
// portable under plain `tsc` — no bundling, no peer deps. `better-call` is
// re-exported directly, not just via futonic: when the tree holds multiple
// better-call copies, spindesk's endpoints resolve to its *own* copy, which
// futonic's re-export wouldn't cover.
export type * from "better-call";
export type * from "futonic";

const configSchema = z.object({
	auth: z.custom<AuthLike>((value) => value != null, {
		message: "auth is required",
	}),
	agentUserIds: z.array(z.string()).optional(),
	agentEmails: z.array(z.string()).optional(),
	managementApiKey: z.string().optional(),
	availableTags: z.array(z.string()).optional(),
	metadataSchema: z.custom<StandardSchemaV1>().optional(),
	maxAttachmentBytes: z.number().optional(),
	onActivity: z
		.custom<OnActivity>((value) => value == null || typeof value === "function")
		.optional(),
});

export const spindeskServiceDefinition = defineService({
	id: "spindesk",
	dbSchema: serviceDeskSchema,
	configSchema,
	endpoints: (defineEndpoint) => createSpindeskEndpoints(defineEndpoint),
});

const spindeskConstructor = createFutonicServiceConstructor(
	spindeskServiceDefinition,
);

/**
 * Spindesk authenticates most requests with a better-auth session cookie and
 * the management API with a shared-secret header, so the service documents both
 * schemes itself rather than leaning on the host to declare them. Hosts can
 * still extend `securitySchemes` or override `security` via their own `openApi`
 * options.
 */
const sessionCookieScheme: SecurityScheme = {
	type: "apiKey",
	in: "cookie",
	name: "better-auth.session_token",
	description:
		"better-auth session cookie. Obtained by signing in through the host's better-auth routes (e.g. `POST /api/auth/sign-in/email`) and sent automatically by the browser on same-origin requests. A missing or invalid session yields `401 Unauthorized`.",
};

const managementApiKeyScheme: SecurityScheme = {
	type: "http",
	scheme: "bearer",
	description:
		"Shared-secret key for the management API, sent as an `Authorization: Bearer <key>` token. Matched against the host's configured `managementApiKey`; unlike the rest of the API it requires no better-auth session. A missing or invalid key yields `401 Unauthorized`.",
};

function withAuthDocs(options: HandlerOptions): HandlerOptions {
	if (options.openApi === false) return options;
	const openApi = options.openApi ?? {};
	return {
		...options,
		openApi: {
			...openApi,
			securitySchemes: {
				sessionCookie: sessionCookieScheme,
				managementApiKey: managementApiKeyScheme,
				...openApi.securitySchemes,
			},
			security: openApi.security ?? [{ sessionCookie: [] }],
		},
	};
}

/** Options accepted by the service factory (`config` + `database`). */
export type SpindeskArgs = Parameters<typeof spindeskConstructor>[0];

/**
 * The service's endpoints, viewed with ticket `metadata` typed as `M`. The
 * runtime endpoints are metadata-agnostic; `M` is the compile-time shape the
 * caller pins via {@link createSpindesk}.
 */
export type SpindeskEndpoints<M extends TicketMetadata = TicketMetadata> =
	ReturnType<typeof createSpindeskEndpoints<M>>;

/** Endpoints type for the type-safe futonic/better-call client. */
export type SpindeskRouter<M extends TicketMetadata = TicketMetadata> =
	SpindeskEndpoints<M>;

/**
 * A Standard Schema for ticket `metadata`, typed to the shape `M`. Pass one as
 * `config.metadataSchema` to validate metadata at runtime and infer its type.
 */
export type TicketMetadataSchema<M extends TicketMetadata = TicketMetadata> =
	StandardSchemaV1<unknown, M>;

/**
 * Build the service, typing ticket `metadata` end-to-end — the create/update
 * request bodies, the ticket responses, and the {@link createSpindeskClient}
 * results all surface the metadata type. There are two ways to supply it:
 *
 * - Pass a `config.metadataSchema` (any Standard Schema). `M` is inferred from
 *   it — no type argument needed — and metadata is validated against it at
 *   runtime (400 on failure).
 * - Or pass a type argument — `createSpindesk<MyMeta>(…)` — for compile-time
 *   typing only, with no runtime validation.
 *
 * Both default to an open record, so plain `createSpindesk(…)` is unchanged.
 */
export function createSpindesk<M extends TicketMetadata = TicketMetadata>(
	options: Omit<SpindeskArgs, "config"> & {
		config: Omit<SpindeskArgs["config"], "metadataSchema"> & {
			metadataSchema?: TicketMetadataSchema<M>;
		};
	},
) {
	const service = spindeskConstructor<SpindeskEndpoints<M>>(options);
	return {
		...service,
		createHandler: (handlerOptions: HandlerOptions) =>
			service.createHandler(withAuthDocs(handlerOptions)),
	};
}
