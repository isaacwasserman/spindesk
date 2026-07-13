import { type ClientOptions, createClient } from "better-call/client";
import type { SpindeskRouter } from "./index.js";

export type SpindeskClient = ReturnType<typeof createClient<SpindeskRouter>>;

/**
 * Build a type-safe client for the service-desk endpoints. The options type is
 * preserved (via `const`) so per-client settings flow into the call types —
 * e.g. `throw: true` makes every call return the payload directly and throw on
 * error, instead of the `{ data, error }` envelope.
 */
export function createSpindeskClient<const Options extends ClientOptions>(
	options: Options,
): ReturnType<typeof createClient<SpindeskRouter, Options>> {
	return createClient<SpindeskRouter, Options>(options);
}
