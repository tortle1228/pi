// Register a standalone search tool and synchronize its availability with the selected provider.
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "../../core/extensions/types.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../../core/tools/truncate.ts";
import { getSearchBackend } from "./search.ts";

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

/** Register provider-aware web search without changing other tools' active states. */
export default function webSearch(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "web_search",
			label: "Web Search",
			description: "Search the web for current information using the selected provider. Returns source links.",
			promptSnippet: "Search the web for current information and source links",
			promptGuidelines: ["Cite the source URLs returned by web_search when using search results."],
			defaultActive: false,
			parameters: Type.Object({ query: Type.String({ minLength: 1, description: "Web search query" }) }),
			async execute(_id, { query }, signal, _onUpdate, ctx) {
				const backend = getSearchBackend(ctx.model?.provider);
				if (!backend)
					throw new Error(`Web search is not supported for provider "${ctx.model?.provider ?? "none"}".`);
				if (!query.trim()) throw new Error("Search query must not be blank.");
				const result = await backend.search(query, ctx, signal);
				return {
					content: [{ type: "text", text: limitResult(result.text) }],
					details: { backend: result.backend },
				};
			},
		}),
	);

	const synchronize = (ctx: ExtensionContext) => {
		const active = pi.getActiveTools();
		const supported = getSearchBackend(ctx.model?.provider) !== undefined;
		// Merged settings layers append modifiers, and the last one wins, as in `applyToolModifiers`.
		const defaultTools = pi.getSettings().defaultTools ?? [];
		const optedOut = defaultTools.lastIndexOf("-web_search") > defaultTools.lastIndexOf("+web_search");
		if (supported && !optedOut && !active.includes("web_search")) pi.setActiveTools([...active, "web_search"]);
		else if (!supported && active.includes("web_search")) {
			pi.setActiveTools(active.filter((name) => name !== "web_search"));
		}
	};
	pi.on("session_start", (_event, ctx) => synchronize(ctx));
	pi.on("model_select", (_event, ctx) => synchronize(ctx));
	// /tree restores the branch's recorded tools but keeps the current model.
	pi.on("session_tree", (_event, ctx) => synchronize(ctx));
}
