import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/client.ts", "src/drizzle.ts"],
	format: ["esm"],
	target: "node18",
	outDir: "dist",
	splitting: true,
	sourcemap: true,
	clean: true,
	dts: false,
});
