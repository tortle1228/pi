// Register a standalone search tool and synchronize its availability with the selected provider.
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "../../core/extensions/types.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../../core/tools/truncate.ts";
import { extractParallel, parallelApiKey, researchParallel } from "./parallel.ts";
import { getXSearchBackend, resolveWebSearch, type SearchBackend } from "./search.ts";

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
	// The follow-up handle is this one trailing line; a long answer must not lose it.
	const idLine = text.match(/^Response ID: .+$/m)?.[0];
	const body = idLine && !head.includes(idLine) ? `${head}\n\n${idLine}` : head;
	return `${body}\n\n[Search results truncated: showing ${formatSize(Buffer.byteLength(body))} of ${formatSize(result.totalBytes)}.]`;
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
		description:
			"Search the web for current information. Uses the selected provider when it supports web search, and Parallel when it does not or that search fails. Returns source links.",
		promptSnippet: "Search the web for current information and source links",
		guideline: "Cite the source URLs returned by web_search when using search results.",
		queryDescription: "Web search query",
		unsupported: "Web search",
		resolve: resolveWebSearch,
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

const parallelToolNames = ["web_fetch", "web_research"] as const;
const parallelAuth = "Parallel authentication required. Set PARALLEL_API_KEY.";

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
						details: result.fallbackFrom
							? { backend: result.backend, fallbackFrom: result.fallbackFrom }
							: { backend: result.backend },
					};
				},
			}),
		);
	}

	pi.registerTool(
		defineTool({
			name: "web_fetch",
			label: "Web Fetch",
			description:
				"Extract excerpts from public http(s) URLs with Parallel. A failed URL is reported as an error line.",
			promptSnippet: "Extract excerpts from URLs with Parallel",
			promptGuidelines: ["Cite the source URLs returned by web_fetch."],
			defaultActive: false,
			parameters: Type.Object({
				urls: Type.Array(Type.String({ minLength: 1 }), {
					minItems: 1,
					maxItems: 20,
					description: "Public http(s) URLs to extract, at most 20",
				}),
				objective: Type.Optional(
					Type.String({ description: "What to focus the excerpts on. Omit to return the default excerpts." }),
				),
			}),
			async execute(_id, { urls, objective }, signal) {
				const apiKey = parallelApiKey();
				if (!apiKey) throw new Error(parallelAuth);
				const targets = urls.map((value) => {
					let url: URL;
					try {
						url = new URL(value);
					} catch {
						throw new Error(`Invalid URL: ${value}`);
					}
					if (url.protocol !== "http:" && url.protocol !== "https:") {
						throw new Error(`URL must be http or https: ${value}`);
					}
					if (url.username || url.password) throw new Error("URL must not include a username or password.");
					return url.href;
				});
				const text = await extractParallel(targets, objective?.trim() || undefined, apiKey, signal);
				return { content: [{ type: "text", text: limitResult(text) }], details: { backend: "parallel" } };
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "web_research",
			label: "Web Research",
			description:
				"Answer a self-contained question from the live web with Parallel. Returns a cited answer and a Response ID for follow-ups.",
			promptSnippet: "Research a question on the web with Parallel and return citations",
			promptGuidelines: [
				"Cite the source URLs returned by web_research.",
				"Write query so it stands alone without the conversation. For a follow-up on the same question, pass the returned Response ID as previous_response_id.",
			],
			defaultActive: false,
			parameters: Type.Object({
				query: Type.String({ minLength: 1, description: "Self-contained research question" }),
				effort: Type.Optional(
					Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
						description: "Research depth. Defaults to medium.",
					}),
				),
				previous_response_id: Type.Optional(
					Type.String({
						minLength: 1,
						maxLength: 512,
						description: "Response ID from an earlier web_research call on the same question",
					}),
				),
			}),
			async execute(_id, { query, effort, previous_response_id }, signal) {
				const apiKey = parallelApiKey();
				if (!apiKey) throw new Error(parallelAuth);
				if (!query.trim()) throw new Error("Research query must not be blank.");
				const text = await researchParallel(query, effort ?? "medium", previous_response_id, apiKey, signal);
				return { content: [{ type: "text", text: limitResult(text) }], details: { backend: "parallel" } };
			},
		}),
	);

	const synchronize = (ctx: ExtensionContext) => {
		let active = pi.getActiveTools();
		// Merged settings layers append modifiers, and the last one wins, as in `applyToolModifiers`.
		const defaultTools = pi.getSettings().defaultTools ?? [];
		const optedOut = (name: string) => defaultTools.lastIndexOf(`-${name}`) > defaultTools.lastIndexOf(`+${name}`);
		let changed = false;
		const hasParallel = parallelApiKey() !== undefined;
		for (const tool of searchTools) {
			const supported = tool.resolve(ctx.model?.provider) !== undefined && !optedOut(tool.name);
			if (supported && !active.includes(tool.name)) {
				active = [...active, tool.name];
				changed = true;
			} else if (!supported && active.includes(tool.name)) {
				active = active.filter((name) => name !== tool.name);
				changed = true;
			}
		}
		for (const name of parallelToolNames) {
			const supported = hasParallel && !optedOut(name);
			if (supported && !active.includes(name)) {
				active = [...active, name];
				changed = true;
			} else if (!supported && active.includes(name)) {
				active = active.filter((activeName) => activeName !== name);
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
