import { APIError } from "better-call";
import { parse } from "liqe";
import { TICKET_STATUS } from "./types";

/**
 * Boolean filter tree consumed by the (patched) futonic adapter's
 * `findMany({ filter })` / `count({ filter })`. Structurally matches futonic's
 * own `FilterNode`, so it's passed through directly.
 */
export type FilterOp =
	| "eq"
	| "ne"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "in"
	| "not_in"
	| "contains"
	| "startsWith"
	| "endsWith"
	| "isNull"
	| "isNotNull";

export type FilterNode =
	| { type: "and" | "or"; nodes: FilterNode[] }
	| { type: "not"; node: FilterNode }
	| { type: "cond"; field: string; op: FilterOp; value?: unknown };

/**
 * Allowlisted query fields (camelCase, the API vocabulary) → the snake_case
 * column and how to compare it. Anything not listed is rejected, so a query
 * can never touch an arbitrary column.
 */
type FieldKind = "text" | "exact" | "enum" | "tag" | "archived" | "date";
const FIELDS: Record<string, { column: string; kind: FieldKind }> = {
	subject: { column: "subject", kind: "text" },
	description: { column: "description", kind: "text" },
	status: { column: "status", kind: "enum" },
	assignee: { column: "assignee_id", kind: "exact" },
	tag: { column: "tags", kind: "tag" },
	archived: { column: "archived_at", kind: "archived" },
	createdAt: { column: "created_at", kind: "date" },
	updatedAt: { column: "updated_at", kind: "date" },
};

const CMP: Record<string, FilterOp> = {
	":>": "gt",
	":>=": "gte",
	":<": "lt",
	":<=": "lte",
};

function bad(message: string): never {
	throw new APIError("BAD_REQUEST", { message });
}

function tagToCond(node: any): FilterNode {
	const value = node.expression?.value;
	const opStr: string = node.operator?.operator ?? ":";
	const term = value === undefined || value === null ? "" : String(value);

	// Bare term (no field): match subject OR description.
	if (node.field?.type !== "Field") {
		return {
			type: "or",
			nodes: [
				{ type: "cond", field: "subject", op: "contains", value: term },
				{ type: "cond", field: "description", op: "contains", value: term },
			],
		};
	}

	const spec = FIELDS[node.field.name];
	if (!spec) bad(`Unknown filter field: ${node.field.name}`);

	// Range/comparison operators only make sense for date fields.
	if (opStr !== ":") {
		const op = CMP[opStr];
		if (!op || spec.kind !== "date") {
			bad(`Operator "${opStr}" not supported on field "${node.field.name}"`);
		}
		return { type: "cond", field: spec.column, op, value: term };
	}

	switch (spec.kind) {
		case "text":
			return { type: "cond", field: spec.column, op: "contains", value: term };
		case "exact":
		case "date":
			return { type: "cond", field: spec.column, op: "eq", value: term };
		case "enum":
			if (!TICKET_STATUS.includes(term as never)) {
				bad(`Invalid status: ${term}`);
			}
			return { type: "cond", field: spec.column, op: "eq", value: term };
		case "tag":
			// tags stored space-delimited (" billing urgent "); match a token.
			return {
				type: "cond",
				field: spec.column,
				op: "contains",
				value: ` ${term} `,
			};
		case "archived": {
			const truthy = term === "true" || term === "1";
			return {
				type: "cond",
				field: spec.column,
				op: truthy ? "isNotNull" : "isNull",
			};
		}
	}
}

function walk(node: any): FilterNode {
	switch (node?.type) {
		case "LogicalExpression":
			return {
				type: node.operator?.operator === "OR" ? "or" : "and",
				nodes: [walk(node.left), walk(node.right)],
			};
		case "UnaryOperator": // NOT
			return { type: "not", node: walk(node.operand) };
		case "ParenthesizedExpression":
			return walk(node.expression);
		case "Tag":
			return tagToCond(node);
		case "EmptyExpression":
			return { type: "and", nodes: [] };
		default:
			bad(`Unsupported query expression: ${node?.type ?? "unknown"}`);
	}
}

/** Whether a query references the `archived` field (so we don't force-hide). */
export function mentionsArchived(query: string): boolean {
	return /(^|[\s(])archived\s*:/.test(query);
}

/** Free-text search: match the raw string against subject OR description. */
function freeTextFilter(text: string): FilterNode {
	return {
		type: "or",
		nodes: [
			{ type: "cond", field: "subject", op: "contains", value: text },
			{ type: "cond", field: "description", op: "contains", value: text },
		],
	};
}

/**
 * Parse a Lucene query string into a FilterNode over the ticket columns.
 * Bare terms already search subject/description; input that isn't valid Lucene
 * falls back to a plain free-text search of the whole string (so the filter box
 * doubles as a search box). Unknown *fields* still throw `400`. Blank → null.
 */
export function parseLuceneToFilter(query: string): FilterNode | null {
	const trimmed = query.trim();
	if (!trimmed) return null;
	let ast: unknown;
	try {
		ast = parse(trimmed);
	} catch {
		// Not valid Lucene — treat the raw input as free text.
		return freeTextFilter(trimmed);
	}
	return walk(ast);
}
