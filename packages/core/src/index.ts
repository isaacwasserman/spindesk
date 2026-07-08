/**
 * servicedesk — an embeddable futonic service.
 *
 * A host application installs this and calls the factory with a database driver
 * + provider and a better-auth instance (via `config`). futonic opens a Kysely
 * instance over that connection, builds the router, and returns a service whose
 * `handler` is a web-standard `(Request) => Promise<Response>`. The service is
 * API-only; the host provides the UI and creates the service's tables.
 */
import type { Middleware } from "better-call";
import { createFutonicServiceConstructor } from "futonic";
import { z } from "zod";
import { createAuthMiddleware } from "./auth-middleware";
import { createServiceDeskEndpoints } from "./endpoints";
import { serviceDeskId, serviceDeskSchema } from "./schema";
import type { AuthLike } from "./types";

/**
 * Config validated at construction. futonic requires a standard-schema for the
 * config; zod v4 schemas satisfy that. `auth` is passed through untouched (it's
 * a live better-auth instance, not plain data), so it's validated only for
 * presence.
 */
const configSchema = z.object({
	auth: z.custom<AuthLike>((value) => value != null, {
		message: "auth is required",
	}),
	agentUserIds: z.array(z.string()).optional(),
	agentEmails: z.array(z.string()).optional(),
	availableTags: z.array(z.string()).optional(),
	maxAttachmentBytes: z.number().optional(),
});

/**
 * The service constructor. `endpoints` is a factory: futonic passes its own
 * ServiceContext-injecting middleware in `use`; we append the auth middleware
 * (which reads that context) so every endpoint authenticates.
 */
const createServiceDesk = createFutonicServiceConstructor({
	id: serviceDeskId,
	dbSchema: serviceDeskSchema,
	configSchema,
	endpoints: (use) =>
		createServiceDeskEndpoints([
			...(use as unknown as Middleware[]),
			createAuthMiddleware(),
		]),
});

/** Options accepted by the service factory (`config` + `database`). */
export type ServiceDeskArgs = Parameters<typeof createServiceDesk>[0];

export const servicedesk = (args: ServiceDeskArgs) => createServiceDesk(args);

/** Endpoints type for the type-safe futonic/better-call client. */
export type ServiceDeskRouter = ReturnType<typeof createServiceDeskEndpoints>;

export { serviceDeskId, serviceDeskSchema } from "./schema";
export type { ServiceDeskSchema } from "./schema";
export type { Role, ServiceDeskConfig, ServiceDeskIdentity } from "./types";
