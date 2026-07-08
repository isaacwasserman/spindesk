import { $ } from "bun";

console.log("[@spindesk/core] Building...");

await $`rm -rf dist`;
await Bun.build({
	entrypoints: ["src/index.ts", "src/drizzle.ts"],
	outdir: "dist",
	target: "node",
	format: "esm",
	external: [
		"better-call",
		"futonic",
		"futonic/drizzle",
		"drizzle-orm",
		"kysely",
		"liqe",
		"zod",
	],
});

// Generate declarations
await $`bunx tsc --emitDeclarationOnly`;

console.log("[@spindesk/core] Build complete.");
