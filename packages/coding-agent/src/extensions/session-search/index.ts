// Optional built-in session retrieval tools, also available to SDK resource loaders.
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createSessionReadToolDefinition, createSessionSearchToolDefinition } from "./tool.ts";

/** Register read-only session tools without activating them by default. */
export function createSessionSearchExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool(createSessionSearchToolDefinition());
		pi.registerTool(createSessionReadToolDefinition());
	};
}

export default createSessionSearchExtension();
