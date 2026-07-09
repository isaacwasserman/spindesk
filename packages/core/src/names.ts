import type { AuthLike, AuthUser } from "./types.js";

/**
 * Resolves display names/emails for better-auth user ids by reading better-auth's
 * own `user` table through the injected auth instance's DB adapter. Names are
 * looked up live (never snapshotted into the service's tables), so renames in
 * the host's auth are reflected immediately.
 *
 * Returns a map of id → { name, email }; ids with no matching user are absent,
 * letting callers fall back to the raw id.
 */
export async function resolveUserNames(
	auth: AuthLike,
	ids: (string | null | undefined)[],
): Promise<Map<string, { name: string | null; email: string | null }>> {
	const unique = [...new Set(ids.filter((id): id is string => !!id))];
	const map = new Map<string, { name: string | null; email: string | null }>();
	if (unique.length === 0) return map;

	const ctx = await auth.$context;
	const rows = await ctx.adapter.findMany<AuthUser>({
		model: "user",
		where: [{ field: "id", value: unique, operator: "in" }],
		select: ["id", "name", "email"],
	});
	for (const row of rows) {
		map.set(row.id, { name: row.name ?? null, email: row.email ?? null });
	}
	return map;
}
