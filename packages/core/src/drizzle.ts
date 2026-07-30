import {
	type DrizzleBuilders,
	type DrizzleDialect,
	generateServiceDrizzleSchema,
	storageTableName,
} from "futonic";
import { spindeskServiceDefinition } from "./index.js";

export type { DrizzleBuilders, DrizzleDialect };

/**
 * Physical name of the table backing futonic's built-in database storage
 * adapter, where attachment bytes land unless the host supplies its own
 * `storage.provider`.
 */
export const SPINDESK_STORAGE_TABLE_NAME: string = storageTableName("spindesk");

/**
 * Builds the `spindesk_*` Drizzle tables for a host's schema. The host passes
 * its own drizzle dialect module (e.g. `import * as pg from "drizzle-orm/pg-core"`),
 * so the returned tables are the host's drizzle-orm version — no version
 * coupling with the version spindesk was built against.
 *
 * The result includes `spindeskStorageObjects`, the built-in store's table;
 * drop that key if the host backs attachments with its own provider.
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
