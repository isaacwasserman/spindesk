import { createClient } from "futonic/client";
import type { SpindeskRouter } from "./index.js";

export function createSpindeskClient(
	options: Parameters<typeof createClient>[0],
): ReturnType<typeof createClient<SpindeskRouter>> {
	return createClient<SpindeskRouter>(options);
}
