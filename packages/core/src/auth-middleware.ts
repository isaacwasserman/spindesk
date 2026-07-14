import { timingSafeEqual } from "node:crypto";
import { APIError } from "better-call";
import type {
	Role,
	ServiceDeskConfig,
	ServiceDeskIdentity,
	SvcCtx,
} from "./types.js";

/** Header carrying the management API key on management-only endpoints. */
export const MANAGEMENT_KEY_HEADER = "x-management-api-key";

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

	const row = await svc.db
		.selectFrom("users")
		.selectAll()
		.where("id", "=", userId)
		.executeTakeFirst();
	if (!row) {
		await svc.db
			.insertInto("users")
			.values({
				id: userId,
				role: isConfiguredAgent ? "agent" : "user",
				createdAt: new Date().toISOString(),
			})
			.execute();
		return { userId, role: isConfiguredAgent ? "agent" : "user" };
	}
	if (row.role === "user" && isConfiguredAgent) {
		// Physically promote a configured agent whose row predates the config
		// (or was created before they were seeded). This persists, so once
		// promoted their id can be dropped from config.
		await svc.db
			.updateTable("users")
			.set({ role: "agent" })
			.where("id", "=", userId)
			.execute();
		return { userId, role: "agent" };
	}
	return { userId, role: row.role as Role };
}

/** Throws 403 unless the identity has the "agent" role. */
export function requireAgent(identity: ServiceDeskIdentity): void {
	if (identity.role !== "agent") {
		throw new APIError("FORBIDDEN", { message: "Agent role required" });
	}
}

function keysMatch(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Throws 401 unless the request carries the configured management API key in the
 * `x-management-api-key` header. When no key is configured, all callers are
 * rejected (the management surface is disabled).
 */
export function requireManagementKey(
	config: ServiceDeskConfig,
	headers: Headers,
): void {
	const expected = config.managementApiKey;
	const provided = headers.get(MANAGEMENT_KEY_HEADER);
	if (!expected || !provided || !keysMatch(provided, expected)) {
		throw new APIError("UNAUTHORIZED", {
			message: "Invalid management API key",
		});
	}
}
