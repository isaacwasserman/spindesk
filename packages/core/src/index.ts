import { createFutonicServiceConstructor, defineService } from "futonic";
import { z } from "zod";
import { createSpindeskEndpoints } from "./endpoints.js";
import { serviceDeskSchema } from "./schema.js";
import type { AuthLike } from "./types.js";

export type { Role } from "./types.js";

// Re-export futonic's public type surface (which itself re-exports the
// better-call types futonic exposes). This makes every type that appears in
// `createSpindesk`'s signature nameable to consumers via `@spindesk/core`, so a
// plain `tsc` build stays portable — no declaration bundling, and no `futonic`
// or `better-call` peer dependency for consumers.
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

export const createSpindesk = createFutonicServiceConstructor(
	spindeskServiceDefinition,
);

/** Options accepted by the service factory (`config` + `database`). */
export type SpindeskArgs = Parameters<typeof createSpindesk>[0];

/** Endpoints type for the type-safe futonic/better-call client. */
export type SpindeskRouter = ReturnType<typeof createSpindesk>["endpoints"];
