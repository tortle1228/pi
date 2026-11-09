import type { InlineExtension } from "../core/extensions/types.ts";
import claudeMemoryExtension from "./claude-memory/index.ts";
import codemodeExtension from "./codemode/index.ts";
import exaoneLimitsExtension from "./exaone-limits/index.ts";
import imageExtension from "./image/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import planModeExtension from "./plan-mode/index.ts";
import requestUserInputExtension from "./request-user-input/index.ts";
import tasksExtension from "./tasks/index.ts";
import terminalExtension from "./terminal/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import webSearchExtension from "./web-search/index.ts";
import worktreeExtension from "./worktree/index.ts";
import youShouldKnowExtension from "./you-should-know/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	{ name: "plan-mode", factory: planModeExtension, builtin: true },
	{ name: "request-user-input", factory: requestUserInputExtension, builtin: true },
	{ name: "claude-memory", factory: claudeMemoryExtension, builtin: true },
	{ name: "worktree", factory: worktreeExtension, builtin: true },
	{ name: "image", factory: imageExtension, builtin: true },
	{ name: "you-should-know", factory: youShouldKnowExtension, builtin: true },
	{ name: "exaone-limits", factory: exaoneLimitsExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, `web_search`, or `/mcp` (such as a
	// third-party MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "web-search", factory: webSearchExtension, replaceable: true, builtin: true },
	{ name: "tasks", factory: tasksExtension, replaceable: true, builtin: true },
	{ name: "terminal", factory: terminalExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
