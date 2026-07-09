import { nodeResolve } from "@rollup/plugin-node-resolve";
import { dts } from "rollup-plugin-dts";

const external = [/^drizzle-orm/];

const entries = ["index", "client", "drizzle"];

export default entries.map((name) => ({
	input: `src/${name}.ts`,
	output: { file: `dist/${name}.d.ts`, format: "es" },
	external,
	plugins: [
		nodeResolve({
			extensions: [".ts", ".d.ts", ".mts", ".d.mts", ".js", ".mjs"],
			exportConditions: ["types", "import", "default"],
		}),
		dts({ respectExternal: true }),
	],
}));
