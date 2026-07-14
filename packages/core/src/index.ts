import { createFutonicServiceConstructor, defineService } from "futonic";
import { z } from "zod";
import type { OnActivity } from "./activity.js";
import { createSpindeskEndpoints } from "./endpoints.js";
import { serviceDeskSchema } from "./schema.js";
import type { AuthLike } from "./types.js";

export type { Role } from "./types.js";
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
	availableTags: z.array(z.string()).optional(),
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

export const createSpindesk = createFutonicServiceConstructor(
	spindeskServiceDefinition,
);

/** Options accepted by the service factory (`config` + `database`). */
export type SpindeskArgs = Parameters<typeof createSpindesk>[0];

/** Endpoints type for the type-safe futonic/better-call client. */
export type SpindeskRouter = ReturnType<typeof createSpindesk>["endpoints"];
