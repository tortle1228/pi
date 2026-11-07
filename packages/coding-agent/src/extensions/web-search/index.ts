// Register a standalone search tool and synchronize its availability with the selected provider.
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "../../core/extensions/types.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../../core/tools/truncate.ts";
import { getSearchBackend, getXSearchBackend, type SearchBackend } from "./search.ts";

/**
 * Keep the result within the standard tool output limit.
 * shortcut: an OpenAI answer over the limit loses its trailing source list; keep sources separately if that happens.
 */
function limitResult(text: string): string {
	const result = truncateHead(text);
	if (!result.truncated) return text;
	// A search result can be one long JSON line, which truncateHead would drop entirely.
	const head = result.firstLineExceedsLimit
		? Buffer.from(text).subarray(0, DEFAULT_MAX_BYTES).toString()
		: result.content;
	return `${head}\n\n[Search results truncated: showing ${formatSize(Buffer.byteLength(head))} of ${formatSize(result.totalBytes)}.]`;
}

interface SearchTool {
	name: "web_search" | "x_search";
	label: string;
	description: string;
	promptSnippet: string;
	guideline: string;
	queryDescription: string;
	unsupported: string;
	resolve(provider: string | undefined): SearchBackend | undefined;
}

const searchTools: readonly SearchTool[] = [
	{
		name: "web_search",
		label: "Web Search",
		description: "Search the web for current information using the selected provider. Returns source links.",
		promptSnippet: "Search the web for current information and source links",
		guideline: "Cite the source URLs returned by web_search when using search results.",
		queryDescription: "Web search query",
		unsupported: "Web search",
		resolve: getSearchBackend,
	},
	{
		name: "x_search",
		label: "X Search",
		description: "Search posts on X (Twitter) using xAI. Returns source links.",
		promptSnippet: "Search posts on X and return source links",
		guideline: "Cite the source URLs returned by x_search when using search results.",
		queryDescription: "X post search query",
		unsupported: "X search",
		resolve: getXSearchBackend,
	},
];

/** Register provider-aware web and X search without changing other tools' active states. */
export default function webSearch(pi: ExtensionAPI): void {
	for (const tool of searchTools) {
		pi.registerTool(
			defineTool({
				name: tool.name,
				label: tool.label,
				description: tool.description,
				promptSnippet: tool.promptSnippet,
				promptGuidelines: [tool.guideline],
				defaultActive: false,
				parameters: Type.Object({ query: Type.String({ minLength: 1, description: tool.queryDescription }) }),
				async execute(_id, { query }, signal, _onUpdate, ctx) {
					const backend = tool.resolve(ctx.model?.provider);
					if (!backend)
						throw new Error(
							`${tool.unsupported} is not supported for provider "${ctx.model?.provider ?? "none"}".`,
						);
					if (!query.trim()) throw new Error("Search query must not be blank.");
					const result = await backend.search(query, ctx, signal);
					return {
						content: [{ type: "text", text: limitResult(result.text) }],
						details: { backend: result.backend },
					};
				},
			}),
		);
	}

	const synchronize = (ctx: ExtensionContext) => {
		let active = pi.getActiveTools();
		// Merged settings layers append modifiers, and the last one wins, as in `applyToolModifiers`.
		const defaultTools = pi.getSettings().defaultTools ?? [];
		let changed = false;
		for (const tool of searchTools) {
			const optedOut = defaultTools.lastIndexOf(`-${tool.name}`) > defaultTools.lastIndexOf(`+${tool.name}`);
			const supported = tool.resolve(ctx.model?.provider) !== undefined && !optedOut;
			if (supported && !active.includes(tool.name)) {
				active = [...active, tool.name];
				changed = true;
			} else if (!supported && active.includes(tool.name)) {
				active = active.filter((name) => name !== tool.name);
				changed = true;
			}
		}
		if (changed) pi.setActiveTools(active);
	};
	pi.on("session_start", (_event, ctx) => synchronize(ctx));
	pi.on("model_select", (_event, ctx) => synchronize(ctx));
	// /tree restores the branch's recorded tools but keeps the current model.
	pi.on("session_tree", (_event, ctx) => synchronize(ctx));
}
