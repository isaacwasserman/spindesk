/**
 * Schema-aware completions for the Lucene filter bar (like the reference
 * CodeMirror example, minus the editor). Pure + DOM-free so it's unit-testable.
 *
 * Given the input value and cursor position it returns the token span to
 * replace (`from`..`to`) and the candidate completions:
 *  - after `field:` → the field's allowed values
 *  - otherwise → field names (with a trailing `:`) and boolean operators
 */
export interface CompletionSchema {
	fields: string[];
	operators: string[];
	/** Enumerable values per field (status, archived, tag, …). */
	fieldValues: Record<string, string[]>;
}

export interface Completion {
	from: number;
	to: number;
	options: string[];
}

const BOUNDARY = new Set([" ", "\t", "(", ")"]);

export function luceneCompletions(
	value: string,
	cursor: number,
	schema: CompletionSchema,
): Completion {
	const upto = value.slice(0, cursor);
	let tokenStart = upto.length;
	while (tokenStart > 0 && !BOUNDARY.has(upto[tokenStart - 1] as string)) {
		tokenStart--;
	}
	const token = upto.slice(tokenStart);
	const colon = token.indexOf(":");

	// Value position: `field:prefix` → complete the field's values.
	if (colon >= 0) {
		const field = token.slice(0, colon);
		const prefix = token.slice(colon + 1).toLowerCase();
		const values = schema.fieldValues[field] ?? [];
		return {
			from: tokenStart + colon + 1,
			to: cursor,
			options: values.filter((v) => v.toLowerCase().startsWith(prefix)),
		};
	}

	// Field / operator position.
	const lower = token.toLowerCase();
	const fields = schema.fields
		.filter((f) => f.toLowerCase().startsWith(lower))
		.map((f) => `${f}:`);
	const operators = schema.operators.filter((o) =>
		o.toLowerCase().startsWith(lower),
	);
	return { from: tokenStart, to: cursor, options: [...fields, ...operators] };
}

/** Apply a chosen completion, returning the new value + cursor position. */
export function applyCompletion(
	value: string,
	completion: Completion,
	option: string,
): { value: string; cursor: number } {
	const next = value.slice(0, completion.from) + option + value.slice(completion.to);
	return { value: next, cursor: completion.from + option.length };
}
