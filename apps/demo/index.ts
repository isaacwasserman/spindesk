/**
 * Demo host entrypoint. Boots the better-auth + service-desk stack and serves
 * it over HTTP. Point a UI at:
 *   - /api/auth/*          → better-auth (sign-up / sign-in / session)
 *   - /api/servicedesk/*   → the service-desk API
 *
 * Seed initial agents with AGENT_USER_IDS (comma-separated better-auth ids).
 */
import ui from "./src/ui/index.html";
import { createApp } from "./src/host/server";

const app = await createApp({
	dbPath: process.env.DB_PATH ?? "servicedesk.db",
	baseURL: process.env.BASE_URL ?? "http://localhost:3000",
	agentUserIds: (process.env.AGENT_USER_IDS ?? "WL70qbh7E8uLxF2zXcoJ5p9OWhzOoHDn")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
	availableTags: (process.env.AVAILABLE_TAGS ?? "billing,bug,feature,urgent,question")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
});

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	// Serve the demo UI at "/"; everything else (the API) falls through to fetch.
	routes: { "/": ui },
	fetch: (req) => app.fetch(req),
	development: { hmr: true },
});

console.log(`Service desk running at ${server.url}`);
console.log("  ui:      /");
console.log("  auth:    /api/auth/*");
console.log(`  service: ${app.mount}/*`);
