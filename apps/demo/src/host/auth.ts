import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";

/**
 * Creates the demo host's better-auth instance. A real host would own this;
 * the service only consumes it through mount config.
 *
 * The `testUtils` plugin exposes `auth.$context.test` helpers (createUser,
 * saveUser, getAuthHeaders) used by the e2e tests. It's harmless in the demo
 * but a production host would drop it.
 */
export function createAuth(database: unknown, baseURL = "http://localhost:3000") {
	return betterAuth({
		database: database as never,
		baseURL,
		emailAndPassword: { enabled: true },
		plugins: [testUtils()],
	});
}

export type Auth = ReturnType<typeof createAuth>;
