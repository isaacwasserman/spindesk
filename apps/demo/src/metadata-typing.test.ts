/**
 * Compile-time proof that a metadata type argument flows end-to-end. The
 * assertions are checked by `tsc`; the runtime body is a formality so the file
 * is also a valid test. Runtime metadata behavior is covered in e2e.test.ts.
 */
import { expect, test } from "bun:test";
import { createSpindeskClient } from "@spindesk/core/client";
import type { Ticket } from "@spindesk/core";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
	? 1
	: 2
	? true
	: false;
type Expect<T extends true> = T;

type Meta = { source: "email" | "web"; priority: number };

async function typedReads() {
	const client = createSpindeskClient<Meta>()({ baseURL: "x", throw: true });
	const ticket = await client("/tickets/:id", { params: { id: "1" } });
	const page = await client("/tickets", {});
	const created = await client("@post/tickets", {
		body: { subject: "s", description: "d", metadata: { source: "web", priority: 1 } },
	});
	return { ticket, page, created };
}

async function untypedReads() {
	const client = createSpindeskClient()({ baseURL: "x", throw: true });
	return client("/tickets/:id", { params: { id: "1" } });
}

type TypedTicket = Awaited<ReturnType<typeof typedReads>>["ticket"];
type TypedPageItem = Awaited<
	ReturnType<typeof typedReads>
>["page"]["tickets"][number];
type TypedCreated = Awaited<ReturnType<typeof typedReads>>["created"];
type UntypedTicket = Awaited<ReturnType<typeof untypedReads>>;

type _exportedTicket = Expect<Equal<Ticket<Meta>["metadata"], Meta>>;
type _clientTicket = Expect<Equal<TypedTicket["metadata"], Meta>>;
type _clientList = Expect<Equal<TypedPageItem["metadata"], Meta>>;
type _clientCreated = Expect<Equal<TypedCreated["metadata"], Meta>>;
type _defaultOpen = Expect<
	Equal<UntypedTicket["metadata"], Record<string, unknown>>
>;

test("metadata type argument flows to the typed client (see type assertions)", () => {
	expect(typeof createSpindeskClient).toBe("function");
});
