import { $ } from "bun";

console.log("[@spindesk/core] Building...");

const pkg = await Bun.file("package.json").json();
const external = [
	...Object.keys(pkg.dependencies ?? {}),
	...Object.keys(pkg.peerDependencies ?? {}),
	"futonic/client",
	"better-call/client",
];

await $`rm -rf dist`;

await Bun.build({
	entrypoints: ["src/index.ts", "src/client.ts", "src/drizzle.ts"],
	outdir: "dist",
	target: "node",
	format: "esm",
	splitting: true,
	external,
});

await $`tsc --emitDeclarationOnly`;

console.log("[@spindesk/core] Build complete.");
