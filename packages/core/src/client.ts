import { type ClientOptions, createClient } from "better-call/client";
import type { PresignedUpload } from "./endpoints.js";
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

export type { PresignedUpload };

/**
 * Send bytes to the `upload` target returned by `POST /tickets/:id/attachments`,
 * covering both shapes an adapter may hand back: a signed `PUT` (what the
 * built-in database store always mints) or a `POST` form carrying the upload
 * policy (what S3 mints for a size-capped upload). The request goes straight to
 * the store, so no credentials are attached. Call the `/complete` endpoint after
 * it resolves to publish the attachment.
 */
export async function sendPresignedUpload(
	upload: PresignedUpload,
	body: Blob,
	options: { contentType?: string; filename?: string } = {},
): Promise<void> {
	const contentType =
		options.contentType || body.type || "application/octet-stream";
	let response: Response;
	if (upload.method === "PUT") {
		response = await fetch(upload.url, {
			method: "PUT",
			headers: { "content-type": contentType, ...upload.headers },
			body,
		});
	} else {
		const form = new FormData();
		for (const [name, value] of Object.entries(upload.fields)) {
			form.append(name, value);
		}
		form.append("file", body, options.filename);
		response = await fetch(upload.url, { method: "POST", body: form });
	}
	if (!response.ok) {
		throw new Error(
			`Presigned upload failed (${response.status}): ${await response.text()}`,
		);
	}
}
