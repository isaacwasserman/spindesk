/**
 * servicedesk — an embeddable futonic service.
 *
 * A host application installs this and calls the factory with a mount path, a
 * database driver, and a better-auth instance (via `config`). The returned
 * RunnableService opens its own database, builds its own router, and exposes
 * `init()` / `handler(request)` / `shutdown()`. The service is API-only; the
 * host provides the UI and creates the service's tables.
 */
import type { Middleware } from "better-call";
import { createService, type EmbeddableService } from "futonic";
import { createAuthMiddleware } from "./auth-middleware";
import { createServiceDeskEndpoints } from "./endpoints";
import { serviceDeskSchema } from "./schema";

/**
 * The service definition. `endpoints` is a factory: futonic passes its own
 * ServiceContext-injecting middleware in `use`; we append the auth middleware
 * (which reads that context) so every endpoint authenticates.
 */
export const serviceDeskDefinition = {
	id: "servicedesk",
	version: "0.1.0",
	dbSchema: serviceDeskSchema,
	endpoints: (use: Middleware[]) =>
		createServiceDeskEndpoints([
			...use,
			createAuthMiddleware() as unknown as Middleware,
		]),

	async onInit(ctx) {
		ctx.logger.info("Service desk initialized");
	},
} satisfies EmbeddableService;

export const servicedesk = createService(serviceDeskDefinition);

/** Router type for the type-safe futonic/better-call client. */
export type ServiceDeskRouter = ReturnType<typeof createServiceDeskEndpoints>;

export { serviceDeskSchema } from "./schema";
export type { ServiceDeskSchema } from "./schema";
export type { Role, ServiceDeskConfig, ServiceDeskIdentity } from "./types";
