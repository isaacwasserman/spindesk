import {
	acceptCompletion,
	autocompletion,
	type Completion,
	type CompletionContext,
	completionStatus,
	currentCompletions,
	selectedCompletionIndex,
	setSelectedCompletion,
	startCompletion,
} from "@codemirror/autocomplete";
import {
	HighlightStyle,
	StreamLanguage,
	syntaxHighlighting,
} from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { type Extension, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { parse } from "liqe";
import React, { useEffect, useRef, useState } from "react";
import type { CompletionSchema } from "./completions";
import { luceneCompletions } from "./completions";

/** Fields whose values we can complete; others accept free text. */
const FIELDS = [
	"subject",
	"description",
	"status",
	"tag",
	"assignee",
	"archived",
	"createdAt",
	"updatedAt",
];
const OPERATORS = ["AND", "OR", "NOT"];

function schemaFor(availableTags: string[]) {
	return {
		fields: FIELDS,
		operators: OPERATORS,
		fieldValues: {
			status: ["open", "pending", "resolved", "closed"],
			archived: ["true", "false"],
			tag: availableTags,
		},
	};
}

/** Minimal Lucene tokenizer for syntax highlighting. */
const luceneLanguage = StreamLanguage.define<unknown>({
	token(stream) {
		if (stream.eatSpace()) return null;
		if (stream.match(/^(AND|OR|NOT)\b/)) return "keyword";
		if (stream.match(/^[A-Za-z_][\w.]*(?=\s*:)/)) return "propertyName";
		if (stream.match(/^:(>=|<=|>|<)?/)) return "operator";
		if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
		if (stream.match(/^'(?:[^'\\]|\\.)*'/)) return "string";
		if (stream.match(/^\d+(?:\.\d+)?/)) return "number";
		if (stream.match(/^[()]/)) return "bracket";
		stream.next();
		return null;
	},
});

const luceneHighlight = HighlightStyle.define([
	{ tag: t.keyword, color: "#d6295a" },
	{ tag: t.propertyName, color: "#6d28d9" },
	{ tag: t.string, color: "#167a4a" },
	{ tag: t.number, color: "#b8500f" },
	{ tag: t.operator, color: "#0e6f8a" },
	{ tag: [t.paren, t.bracket], color: "#8a8aa0" },
]);

const editorTheme = EditorView.theme({
	"&": {
		flex: "1",
		border: "1px solid #bbb",
		borderRadius: "4px",
		fontSize: "0.9rem",
	},
	"&.cm-focused": { outline: "2px solid #9cc0ff" },
	".cm-content": {
		padding: "0.4rem",
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
	},
	".cm-scroller": { overflow: "hidden" },
	".cm-line": { padding: "0" },
	// Hide CodeMirror's built-in completion popup — we render our own React
	// dropdown from the same completion state (see FilterBar).
	".cm-tooltip.cm-tooltip-autocomplete": { display: "none" },
});

/** Snapshot of CodeMirror's completion state for the custom React dropdown. */
export interface CompletionView {
	active: boolean;
	options: readonly Completion[];
	selected: number | null;
}

/** Reject any edit that would introduce a newline — keeps it single-line. */
const singleLine = EditorState.transactionFilter.of((tr) =>
	tr.newDoc.lines > 1 ? [] : tr,
);

/**
 * Builds the CodeMirror extensions for the Lucene filter editor: highlighting,
 * schema-aware autocomplete, LIQE error underlining, single-line, Enter-to-apply,
 * and debounced live filtering. Exported so tests exercise the exact config.
 */
export function filterExtensions(
	getSchema: () => CompletionSchema,
	onApply: (query: string) => void,
	onCompletions?: (view: CompletionView) => void,
): Extension[] {
	let debounce: ReturnType<typeof setTimeout> | null = null;

	const complete = (ctx: CompletionContext) => {
		const c = luceneCompletions(ctx.state.doc.toString(), ctx.pos, getSchema());
		if (!c.options.length) return null;
		return {
			from: c.from,
			to: c.to,
			options: c.options.map((label) =>
				label.endsWith(":")
					? {
							// A field name — insert it, then immediately offer its values.
							label,
							type: "property",
							detail: "field",
							apply: (view: EditorView, _c: unknown, from: number, to: number) => {
								view.dispatch({
									changes: { from, to, insert: label },
									selection: { anchor: from + label.length },
								});
								startCompletion(view);
							},
						}
					: /^(AND|OR|NOT)$/.test(label)
						? { label, type: "keyword", detail: "operator" }
						: { label, type: "enum", detail: "value" },
			),
			// Exclude ":" so typing/deleting a colon re-queries the source
			// (field position → value position) instead of just filtering.
			validFor: /[\w.@-]*/,
		};
	};

	const luceneLint = linter((view) => {
		const text = view.state.doc.toString();
		if (!text.trim()) return [];
		try {
			parse(text);
			return [];
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const col = /column (\d+)/.exec(msg);
			const from = col
				? Math.min(Math.max(Number(col[1]) - 1, 0), text.length)
				: 0;
			return [{ from, to: text.length, severity: "error" as const, message: msg }];
		}
	});

	return [
		luceneLanguage,
		syntaxHighlighting(luceneHighlight),
		autocompletion({ override: [complete], activateOnTyping: true }),
		luceneLint,
		singleLine,
		placeholder("free text, or Lucene e.g. status:open AND tag:billing"),
		editorTheme,
		EditorView.lineWrapping,
		// Enter applies the filter — unless a completion is open (then accept it).
		// Tab accepts the focused completion when the list is open.
		Prec.high(
			keymap.of([
				{
					key: "Enter",
					run: (v) => {
						if (completionStatus(v.state) === "active") return false;
						if (debounce) clearTimeout(debounce);
						onApply(v.state.doc.toString());
						return true;
					},
				},
				{
					key: "Tab",
					run: (v) =>
						completionStatus(v.state) === "active" ? acceptCompletion(v) : false,
				},
			]),
		),
		// Keep the completion list in sync with the current token:
		//  - open it after ":"/"("/space (CodeMirror only auto-activates on word
		//    chars, so these separators wouldn't trigger it), and
		//  - re-query while a list is already open (e.g. after backspacing the
		//    ":" the value list must refresh to field suggestions, not linger).
		EditorView.updateListener.of((u) => {
			if (!u.docChanged) return;
			const pos = u.state.selection.main.head;
			const prev = u.state.sliceDoc(pos - 1, pos);
			const open = completionStatus(u.state) === "active";
			if (open || prev === ":" || prev === "(" || prev === " ") {
				const v = u.view;
				setTimeout(() => startCompletion(v), 0);
			}
		}),
		// Mirror CodeMirror's completion state out to the React dropdown.
		EditorView.updateListener.of((u) => {
			onCompletions?.({
				active: completionStatus(u.state) === "active",
				options: currentCompletions(u.state),
				selected: selectedCompletionIndex(u.state),
			});
		}),
		// Live filtering: debounce edits, apply only when the query parses.
		EditorView.updateListener.of((u) => {
			if (!u.docChanged) return;
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => {
				const text = u.state.doc.toString();
				try {
					if (text.trim()) parse(text);
					onApply(text);
				} catch {
					/* invalid syntax mid-type: wait for a valid query / Enter */
				}
			}, 350);
		}),
	];
}

/**
 * Lucene filter editor with the reference material's full capability:
 * syntax highlighting, schema-aware autocomplete (fields/operators/values),
 * and inline LIQE parse-error underlining. Enter applies; edits also apply
 * live (debounced) once the query parses.
 */
export function FilterBar({
	availableTags,
	onApply,
}: {
	availableTags: string[];
	onApply: (query: string) => void;
}) {
	const host = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	// Latest values read by editor callbacks without reconfiguring the view.
	const schemaRef = useRef(schemaFor(availableTags));
	const applyRef = useRef(onApply);
	// CodeMirror's live completion state, mirrored for our own dropdown.
	const [comp, setComp] = useState<CompletionView>({
		active: false,
		options: [],
		selected: null,
	});

	useEffect(() => {
		schemaRef.current = schemaFor(availableTags);
	}, [availableTags]);
	useEffect(() => {
		applyRef.current = onApply;
	}, [onApply]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: build the editor once
	useEffect(() => {
		if (!host.current) return;
		const view = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: "",
				extensions: filterExtensions(
					() => schemaRef.current,
					(q) => applyRef.current(q),
					setComp,
				),
			}),
		});
		viewRef.current = view;
		return () => view.destroy();
	}, []);

	const clear = () => {
		const view = viewRef.current;
		if (view) {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: "" },
			});
		}
		onApply("");
	};

	// Accept a specific option by index (select it in CM, then accept).
	const pick = (index: number) => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch({ effects: setSelectedCompletion(index) });
		acceptCompletion(view);
		view.focus();
	};

	const iconFor = (c: Completion) =>
		c.type === "property" ? "⌗" : c.type === "keyword" ? "⚙" : "▸";

	return (
		<div className="card">
			<label>Search / filter</label>
			<div className="row">
				<div className="combo">
					<div ref={host} />
					{comp.active && comp.options.length > 0 && (
						<ul className="cmp">
							{comp.options.map((o, i) => (
								<li
									// biome-ignore lint/suspicious/noArrayIndexKey: options are positional
									key={`${o.label}-${i}`}
									className={i === comp.selected ? "sel" : ""}
									// onMouseDown fires before the editor loses focus.
									onMouseDown={(e) => {
										e.preventDefault();
										pick(i);
									}}
								>
									<span className="cmp-ico">{iconFor(o)}</span>
									<span className="cmp-label">{o.label}</span>
									{o.detail && <span className="cmp-detail">{o.detail}</span>}
								</li>
							))}
						</ul>
					)}
				</div>
				<button
					className="primary"
					type="button"
					onClick={() =>
						viewRef.current && onApply(viewRef.current.state.doc.toString())
					}
				>
					Filter
				</button>
				<button type="button" onClick={clear}>
					Clear
				</button>
			</div>
		</div>
	);
}
