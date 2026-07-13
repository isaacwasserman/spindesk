import { createClient } from "futonic/client";
import type { SpindeskRouter } from "./index.js";

export type SpindeskClient = ReturnType<typeof createClient<SpindeskRouter>>;

export function createSpindeskClient(
	options: Parameters<typeof createClient>[0],
): SpindeskClient {
	return createClient<SpindeskRouter>(options);
}
