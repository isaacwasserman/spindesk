import { $ } from "bun";
import { generateDtsBundle } from "dts-bundle-generator";

console.log("[@spindesk/core] Building...");

await $`rm -rf dist`;

const external = [
	"better-call",
	"better-call/client",
	"futonic",
	"futonic/client",
	"kysely",
	"liqe",
	"zod",
];

await Bun.build({
	entrypoints: ["src/index.ts", "src/client.ts"],
	outdir: "dist",
	target: "node",
	format: "esm",
	external,
});

const entries = ["src/index.ts", "src/client.ts"].map((filePath) => ({
	filePath,
	output: { noBanner: true, sortNodes: true },
}));

const [indexDts, clientDts] = generateDtsBundle(entries, {
	preferredConfigPath: "tsconfig.json",
});

await Bun.write("dist/index.d.ts", indexDts);
await Bun.write("dist/client.d.ts", clientDts);

console.log("[@spindesk/core] Build complete.");
