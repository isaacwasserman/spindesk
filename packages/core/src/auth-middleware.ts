import { timingSafeEqual } from "node:crypto";
import { APIError } from "better-call";
import type {
	Role,
	ServiceDeskConfig,
	ServiceDeskIdentity,
	SvcCtx,
} from "./types.js";

/**
 * Header carrying the user id to impersonate. A request that presents it must
 * also carry a valid management API key; the request then acts as that user
 * with that user's own role, without a better-auth session.
 */
export const IMPERSONATION_HEADER = "x-impersonate-user-id";

/**
 * Resolves the current service-desk identity from a service context and the
 * request headers. Normally this verifies the better-auth session, but a
 * management-key request may instead impersonate any user via the
 * {@link IMPERSONATION_HEADER}. Either way it lazily provisions the sidecar
 * user row (default role "user", or "agent" when seeded via config).
 */
export async function resolveIdentity(
	svc: SvcCtx,
	headers: Headers,
): Promise<ServiceDeskIdentity> {
	const config = svc.config as unknown as ServiceDeskConfig;

	const impersonated = headers.get(IMPERSONATION_HEADER);
	if (impersonated) {
		requireManagementKey(config, headers);
		return provisionIdentity(svc, config, impersonated, null);
	}

	const session = await config.auth.api.getSession({ headers });
	if (!session?.user?.id) {
		throw new APIError("UNAUTHORIZED", {
			message: "Authentication required",
		});
	}
	return provisionIdentity(
		svc,
		config,
		session.user.id,
		session.user.email ?? null,
	);
}

/**
 * Resolve the identity for a known better-auth user id, lazily provisioning the
 * sidecar `users` row and physically promoting a configured agent whose row
 * predates the config. `email` enables the `agentEmails` seed; pass null when
 * it's unavailable (e.g. impersonation, which only has an id).
 */
async function provisionIdentity(
	svc: SvcCtx,
	config: ServiceDeskConfig,
	userId: string,
	email: string | null,
): Promise<ServiceDeskIdentity> {
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

function bearerToken(headers: Headers): string | null {
	const header = headers.get("authorization");
	if (!header) return null;
	const [scheme, token] = header.split(" ");
	return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

/**
 * Throws 401 unless the request carries the configured management API key as an
 * `Authorization: Bearer <key>` token. When no key is configured, all callers
 * are rejected (the management surface is disabled).
 */
export function requireManagementKey(
	config: ServiceDeskConfig,
	headers: Headers,
): void {
	const expected = config.managementApiKey;
	const provided = bearerToken(headers);
	if (!expected || !provided || !keysMatch(provided, expected)) {
		throw new APIError("UNAUTHORIZED", {
			message: "Invalid management API key",
		});
	}
}
