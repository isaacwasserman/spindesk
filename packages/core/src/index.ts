import { createFutonicServiceConstructor, defineService } from "futonic";
import { z } from "zod";
import { type TicketMetadata, createSpindeskEndpoints } from "./endpoints.js";
import { serviceDeskSchema } from "./schema.js";
import type { AuthLike } from "./types.js";

export type { Role } from "./types.js";
export type { Ticket, TicketMetadata } from "./endpoints.js";

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
	availableTags: z.array(z.string()).optional(),
	maxAttachmentBytes: z.number().optional(),
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
 * Build the service. Pass a metadata type argument — `createSpindesk<MyMeta>(…)`
 * — to type ticket `metadata` end-to-end: the create/update request bodies, the
 * ticket responses, and the {@link createSpindeskClient} results all surface
 * `MyMeta`. Defaults to an open record, so plain `createSpindesk(…)` is
 * unchanged. Validation stays shape-agnostic; the type is a view you vouch for.
 */
export function createSpindesk<M extends TicketMetadata = TicketMetadata>(
	options: SpindeskArgs,
) {
	return spindeskConstructor<SpindeskEndpoints<M>>(options);
}
