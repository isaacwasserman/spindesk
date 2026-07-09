import { $ } from "bun";

console.log("[@spindesk/core] Building...");

await $`rm -rf dist`;
await Bun.build({
	entrypoints: ["src/index.ts", "src/client.ts"],
	outdir: "dist",
	target: "node",
	format: "esm",
	external: [
		"better-call",
		"better-call/client",
		"futonic",
		"futonic/client",
		"kysely",
		"liqe",
		"zod",
	],
});

// Generate declarations
await $`bunx tsc --emitDeclarationOnly`;

console.log("[@spindesk/core] Build complete.");
