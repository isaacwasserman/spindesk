import { createFutonicServiceConstructor, defineService } from "futonic";
import { z } from "zod";
import { createSpindeskEndpoints } from "./endpoints.js";
import { serviceDeskSchema } from "./schema.js";
import type { AuthLike } from "./types.js";

export type { Role } from "./types.js";

export const spindeskServiceDefinition = defineService({
	id: "spindesk",
	dbSchema: serviceDeskSchema,
	configSchema: z.object({
		auth: z.custom<AuthLike>((value) => value != null, {
			message: "auth is required",
		}),
		agentUserIds: z.array(z.string()).optional(),
		agentEmails: z.array(z.string()).optional(),
		availableTags: z.array(z.string()).optional(),
		maxAttachmentBytes: z.number().optional(),
	}),
	endpoints: (defineEndpoint) => createSpindeskEndpoints(defineEndpoint),
});

export const createSpindesk = createFutonicServiceConstructor(
	spindeskServiceDefinition,
);

/** Options accepted by the service factory (`config` + `database`). */
export type SpindeskArgs = Parameters<typeof createSpindesk>[0];

/** Endpoints type for the type-safe futonic/better-call client. */
export type SpindeskRouter = ReturnType<typeof createSpindesk>["endpoints"];
