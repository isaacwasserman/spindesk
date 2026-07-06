/**
 * Headless test of the real CodeMirror editor: types a query character by
 * character (as `input.type` user events, like a user) and asserts the
 * autocomplete surfaces finite field values (e.g. `tag:` → the tags).
 *
 * happy-dom is registered only for this file's lifetime (beforeAll/afterAll)
 * so it doesn't clobber the global fetch/Request the server e2e tests use.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// biome-ignore lint/suspicious/noExplicitAny: modules loaded after DOM globals exist
let acceptCompletion: any;
// biome-ignore lint/suspicious/noExplicitAny: modules loaded after DOM globals exist
let setSelectedCompletion: any;
// biome-ignore lint/suspicious/noExplicitAny: modules loaded after DOM globals exist
let EditorState: any;
// biome-ignore lint/suspicious/noExplicitAny: same
let EditorView: any;
// biome-ignore lint/suspicious/noExplicitAny: same
let currentCompletions: any;
// biome-ignore lint/suspicious/noExplicitAny: same
let filterExtensions: any;

beforeAll(async () => {
	GlobalRegistrator.register();
	({ EditorState } = await import("@codemirror/state"));
	({ EditorView } = await import("@codemirror/view"));
	({ currentCompletions, acceptCompletion, setSelectedCompletion } =
		await import("@codemirror/autocomplete"));
	({ filterExtensions } = await import("./FilterBar"));
});
afterAll(() => GlobalRegistrator.unregister());

const schema = {
	fields: ["subject", "status", "tag", "assignee", "archived"],
	operators: ["AND", "OR", "NOT"],
	fieldValues: {
		status: ["open", "pending", "resolved", "closed"],
		archived: ["true", "false"],
		tag: ["billing", "bug", "urgent"],
	},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkView() {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	return new EditorView({
		parent,
		state: EditorState.create({
			doc: "",
			extensions: filterExtensions(
				() => schema,
				() => {},
			),
		}),
	});
}

// biome-ignore lint/suspicious/noExplicitAny: view is dynamically typed
async function type(view: any, text: string) {
	for (const ch of text) {
		const pos = view.state.selection.main.head;
		view.dispatch({
			changes: { from: pos, insert: ch },
			selection: { anchor: pos + 1 },
			userEvent: "input.type",
		});
		await sleep(0); // let the ":"-trigger setTimeout run
	}
	await sleep(160); // clear activateOnTypingDelay (100ms)
}

// biome-ignore lint/suspicious/noExplicitAny: view is dynamically typed
async function backspace(view: any) {
	const pos = view.state.selection.main.head;
	view.dispatch({
		changes: { from: pos - 1, to: pos },
		selection: { anchor: pos - 1 },
		userEvent: "delete.backward",
	});
	await sleep(160);
}

// biome-ignore lint/suspicious/noExplicitAny: view is dynamically typed
const labels = (view: any): string[] =>
	(currentCompletions(view.state) ?? []).map((c: { label: string }) => c.label);
// biome-ignore lint/suspicious/noExplicitAny: view is dynamically typed
const sortedLabels = (view: any) => labels(view).sort();

test("typing 'tag:' surfaces the tag values (empty prefix)", async () => {
	const view = mkView();
	await type(view, "tag:");
	expect(sortedLabels(view)).toEqual(["billing", "bug", "urgent"]);
	view.destroy();
});

test("typing 'status:' surfaces all statuses; prefix narrows", async () => {
	const view = mkView();
	await type(view, "status:");
	expect(sortedLabels(view)).toEqual(["closed", "open", "pending", "resolved"]);
	await type(view, "re");
	expect(labels(view)).toEqual(["resolved"]);
	view.destroy();
});

test("field position suggests field names", async () => {
	const view = mkView();
	await type(view, "sta");
	expect(labels(view)).toContain("status:");
	view.destroy();
});

test("backspacing the ':' returns to field suggestions, not values", async () => {
	const view = mkView();
	await type(view, "status:");
	expect(labels(view)).toContain("open"); // value list showing
	await backspace(view); // delete the ":" → doc is "status"
	const after = labels(view);
	expect(after).not.toContain("open"); // stale value list must be gone
	view.destroy();
});

test("completion state syncs to the React dropdown, and pick() applies", async () => {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic
	let last: any = { active: false, options: [], selected: null };
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: "",
			extensions: filterExtensions(
				() => schema,
				() => {},
				// biome-ignore lint/suspicious/noExplicitAny: dynamic
				(v: any) => {
					last = v;
				},
			),
		}),
	});
	await type(view, "tag:");
	expect(last.active).toBe(true);
	expect(last.options.map((o: { label: string }) => o.label)).toContain(
		"urgent",
	);
	// Simulate a click on "urgent": select that index, then accept.
	const idx = last.options.findIndex(
		(o: { label: string }) => o.label === "urgent",
	);
	view.dispatch({ effects: setSelectedCompletion(idx) });
	acceptCompletion(view);
	await sleep(0);
	expect(view.state.doc.toString()).toBe("tag:urgent");
	view.destroy();
});

test("Tab accepts the focused completion", async () => {
	const view = mkView();
	await type(view, "status:pe"); // → ["pending"], selected index 0
	// Simulate the Tab keybinding running against the editor.
	const handled = view.dispatch && (() => {
		// Run the Tab handler via the keymap: dispatch a synthetic keydown.
		const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true });
		view.contentDOM.dispatchEvent(ev);
		return true;
	})();
	expect(handled).toBe(true);
	await sleep(0);
	expect(view.state.doc.toString()).toBe("status:pending");
	view.destroy();
});

test("type a value then backspace through the ':' — no stale values", async () => {
	const view = mkView();
	await type(view, "status:o"); // → ["open"]
	expect(labels(view)).toEqual(["open"]);
	await backspace(view); // → "status:" (all values)
	expect(labels(view)).toContain("pending");
	await backspace(view); // → "status" (field position)
	expect(labels(view)).not.toContain("open");
	expect(labels(view)).not.toContain("pending");
	view.destroy();
});
