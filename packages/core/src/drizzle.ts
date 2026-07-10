import {
	type DrizzleBuilders,
	type DrizzleDialect,
	generateServiceDrizzleSchema,
} from "futonic";
import { spindeskServiceDefinition } from "./index.js";

/**
 * Builds the `spindesk_*` Drizzle tables for a host's schema. The host passes
 * its own drizzle dialect module (e.g. `import * as pg from "drizzle-orm/pg-core"`),
 * so the returned tables are the host's drizzle-orm version — no version
 * coupling with the version spindesk was built against.
 */
export function generateSpindeskSchema<
	D extends DrizzleDialect,
	TDrizzle extends DrizzleBuilders,
>(dialect: D, drizzle: TDrizzle) {
	return generateServiceDrizzleSchema(
		spindeskServiceDefinition,
		dialect,
		drizzle,
	);
}
