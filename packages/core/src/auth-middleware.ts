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

	let row = await svc.db.users.findOne([{ field: "id", value: userId }]);
	if (!row) {
		const role: Role = config.agentUserIds?.includes(userId) ? "agent" : "user";
		row = await svc.db.users.create({
			id: userId,
			role,
			created_at: new Date().toISOString(),
		});
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
