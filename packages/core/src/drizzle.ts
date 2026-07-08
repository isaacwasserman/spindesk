/**
 * Drizzle schema for the service-desk service.
 *
 * Thin wrapper around futonic's `generateDrizzleSchema` that binds this
 * service's schema and id, so a host only has to pick a dialect. Feed the
 * returned tables into your own Drizzle schema and drizzle-kit will emit
 * migrations for the `servicedesk_*` tables.
 *
 * `drizzle-orm` is an optional peer dependency; import this entry point
 * (`@spindesk/core/drizzle`) only when it's installed.
 */
import {
	type DrizzleDialect,
	type InferDrizzleSchema,
	generateDrizzleSchema,
} from "futonic/drizzle";
import {
	type ServiceDeskSchema,
	serviceDeskId,
	serviceDeskSchema,
} from "./schema";

/**
 * Generates the fully-typed Drizzle tables for the service desk in the given
 * dialect. Table names are prefixed with the service id (e.g.
 * `servicedesk_tickets`); the returned record stays keyed by logical name.
 */
export function serviceDeskDrizzleSchema<D extends DrizzleDialect>(
	dialect: D,
): InferDrizzleSchema<ServiceDeskSchema, D, typeof serviceDeskId> {
	return generateDrizzleSchema({
		serviceSchema: serviceDeskSchema,
		dialect,
		prefix: serviceDeskId,
	});
}

export type { DrizzleDialect } from "futonic/drizzle";
