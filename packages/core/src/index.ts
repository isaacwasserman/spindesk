import { createFutonicServiceConstructor } from "futonic";
import { z } from "zod";
import { createServiceDeskEndpoints } from "./endpoints";
import { serviceDeskId, serviceDeskSchema } from "./schema";
import type { AuthLike } from "./types";

/**
 * The service constructor. `endpoints` is a factory: futonic passes a pre-bound
 * `defineEndpoint` whose ServiceContext-injecting middleware is already baked in.
 * `createServiceDeskEndpoints` wraps it to authenticate every endpoint.
 */
export const createServiceDesk = createFutonicServiceConstructor({
	id: serviceDeskId,
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
	endpoints: (defineEndpoint) => createServiceDeskEndpoints(defineEndpoint),
});

/** Options accepted by the service factory (`config` + `database`). */
export type ServiceDeskArgs = Parameters<typeof createServiceDesk>[0];

export const servicedesk = (args: ServiceDeskArgs) => createServiceDesk(args);

/** Endpoints type for the type-safe futonic/better-call client. */
export type ServiceDeskRouter = ReturnType<typeof createServiceDeskEndpoints>;
