/**
 * Case conversion at the API boundary. Database columns stay snake_case; every
 * value crossing the HTTP edge (request bodies/queries and responses) is
 * camelCase. These helpers convert DB rows → API responses.
 */

/** Convert a row's snake_case keys to camelCase (shallow — rows are flat). */
export function toCamel<T = Record<string, unknown>>(
	row: Record<string, unknown>,
): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		const camel = key.replace(/_([a-z0-9])/g, (_, c: string) =>
			c.toUpperCase(),
		);
		out[camel] = value;
	}
	return out as T;
}

/** Convert a list of rows to camelCase. */
export function toCamelList<T = Record<string, unknown>>(
	rows: Record<string, unknown>[],
): T[] {
	return rows.map((r) => toCamel<T>(r));
}
