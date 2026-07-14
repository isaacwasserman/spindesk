import { type ClientOptions, createClient } from "better-call/client";
import type { SpindeskRouter, TicketMetadata } from "./index.js";

export type SpindeskClient<M extends TicketMetadata = TicketMetadata> =
	ReturnType<typeof createClient<SpindeskRouter<M>>>;

/**
 * Build a type-safe client for the service-desk endpoints.
 *
 * Optionally pin the ticket `metadata` type: `createSpindeskClient<MyMeta>()(…)`
 * types `metadata` on every response and request body; it must match the type
 * given to `createSpindesk` on the server. It defaults to an open record, so
 * `createSpindeskClient()(…)` is the untyped form.
 *
 * The metadata type and the options are taken in two steps because TypeScript
 * can't infer the options while a metadata type is given explicitly. The second
 * call preserves the options type (via `const`) so per-client settings flow
 * into the call types — e.g. `throw: true` makes every call return the payload
 * directly and throw on error, instead of the `{ data, error }` envelope.
 */
export function createSpindeskClient<
	M extends TicketMetadata = TicketMetadata,
>() {
	return <const Options extends ClientOptions>(
		options: Options,
	): ReturnType<typeof createClient<SpindeskRouter<M>, Options>> =>
		createClient<SpindeskRouter<M>, Options>(options);
}
