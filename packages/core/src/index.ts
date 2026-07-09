import { createFutonicServiceConstructor } from "futonic";
import { z } from "zod";
import { createSpindeskEndpoints as createSpindeskEndpoints } from "./endpoints";
import { serviceDeskSchema } from "./schema";
import type { AuthLike } from "./types";

export const createSpindesk = createFutonicServiceConstructor({
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

/** Options accepted by the service factory (`config` + `database`). */
export type SpindeskArgs = Parameters<typeof createSpindesk>[0];

/** Endpoints type for the type-safe futonic/better-call client. */
export type SpindeskRouter = ReturnType<typeof createSpindeskEndpoints>;
