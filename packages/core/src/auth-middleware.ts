import { APIError, createMiddleware } from "better-call";
import type {
	Role,
	ServiceDeskConfig,
	ServiceDeskIdentity,
	SvcCtx,
} from "./types";

/**
 * Resolves the current service-desk identity from a service context and the
 * request headers: verifies the better-auth session and lazily provisions the
 * sidecar user row (default role "user", or "agent" when seeded via config).
 */
export async function resolveIdentity(
	svc: SvcCtx,
	headers: Headers,
): Promise<ServiceDeskIdentity> {
	const config = svc.config as unknown as ServiceDeskConfig;
	const session = await config.auth.api.getSession({ headers });
	if (!session?.user?.id) {
		throw new APIError("UNAUTHORIZED", {
			message: "Authentication required",
		});
	}
	const userId = session.user.id;
	const email = session.user.email ?? null;

	const isConfiguredAgent =
		(config.agentUserIds?.includes(userId) ?? false) ||
		(email !== null && (config.agentEmails?.includes(email) ?? false));

	let row = await svc.db.users.findOne([{ field: "id", value: userId }]);
	if (!row) {
		row = await svc.db.users.create({
			id: userId,
			role: isConfiguredAgent ? "agent" : "user",
			created_at: new Date().toISOString(),
		});
	} else if (row.role === "user" && isConfiguredAgent) {
		// Physically promote a configured agent whose row predates the config
		// (or was created before they were seeded). This persists, so once
		// promoted their id can be dropped from config.
		row = (await svc.db.users.update([{ field: "id", value: userId }], {
			role: "agent",
		})) ?? { ...row, role: "agent" };
	}
	return { userId, role: row.role as Role };
}

/**
 * better-call middleware that authenticates the request and attaches
 * `{ serviceDesk: { userId, role } }` onto the handler context.
 *
 * futonic builds the router and prepends its own service middleware, which
 * injects `serviceCtx` onto `ctx.context`. We read it from there — this
 * middleware must run after futonic's (it's appended to `use` downstream).
 */
export function createAuthMiddleware() {
	return createMiddleware(async (ctx) => {
		const serviceCtx = (ctx as unknown as { context: { serviceCtx: SvcCtx } })
			.context.serviceCtx;
		const headers: Headers =
			(ctx.headers as Headers | undefined) ??
			(ctx.request as Request | undefined)?.headers ??
			new Headers();
		const serviceDesk = await resolveIdentity(serviceCtx, headers);
		return { serviceDesk };
	});
}

/** Throws 403 unless the identity has the "agent" role. */
export function requireAgent(identity: ServiceDeskIdentity): void {
	if (identity.role !== "agent") {
		throw new APIError("FORBIDDEN", { message: "Agent role required" });
	}
}
