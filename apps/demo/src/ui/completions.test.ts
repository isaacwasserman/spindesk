import { expect, test } from "bun:test";
import { applyCompletion, luceneCompletions } from "./completions";

const schema = {
	fields: ["subject", "status", "tag", "archived"],
	operators: ["AND", "OR", "NOT"],
	fieldValues: {
		status: ["open", "pending", "resolved", "closed"],
		archived: ["true", "false"],
		tag: ["billing", "bug", "urgent"],
	},
};

const at = (v: string) => luceneCompletions(v, v.length, schema);

test("completes field names and operators by prefix", () => {
	expect(at("sta").options).toEqual(["status:"]);
	expect(at("AN").options).toEqual(["AND"]); // "archived" also starts with "a"
	// "" token → everything
	const all = at("");
	expect(all.options).toContain("subject:");
	expect(all.options).toContain("OR");
});

test("completes field values after a colon", () => {
	expect(at("status:").options).toEqual([
		"open",
		"pending",
		"resolved",
		"closed",
	]);
	expect(at("status:re").options).toEqual(["resolved"]);
	expect(at("tag:bu").options).toEqual(["bug"]);
	expect(at("archived:t").options).toEqual(["true"]);
});

test("completes the token at the cursor in a compound query", () => {
	const value = "status:open AND ta";
	const c = luceneCompletions(value, value.length, schema);
	expect(c.options).toEqual(["tag:"]);
	const applied = applyCompletion(value, c, "tag:");
	expect(applied.value).toBe("status:open AND tag:");
	expect(applied.cursor).toBe(applied.value.length);
});

test("value completion replaces only the value prefix", () => {
	const value = "tag:bil";
	const c = luceneCompletions(value, value.length, schema);
	const applied = applyCompletion(value, c, "billing");
	expect(applied.value).toBe("tag:billing");
});

test("no value completions for free-text fields", () => {
	expect(at("subject:pri").options).toEqual([]);
});
