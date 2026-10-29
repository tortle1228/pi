import type { InlineExtension } from "../core/extensions/types.ts";
import applyPatchExtension from "./apply-patch/index.ts";
import codemodeExtension from "./codemode/index.ts";
import jobsExtension from "./jobs/index.ts";
import llamaExtension from "./llama/index.ts";
import lspExtension from "./lsp/index.ts";
import mcpExtension from "./mcp/index.ts";
import sessionSearchExtension from "./session-search/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	{ name: "apply-patch", factory: applyPatchExtension, replaceable: true, builtin: true },
	{ name: "jobs", factory: jobsExtension, replaceable: true, builtin: true },
	{ name: "lsp", factory: lspExtension, replaceable: true, builtin: true },
	{ name: "session-search", factory: sessionSearchExtension, replaceable: true, builtin: true },
];
