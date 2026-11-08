// Register a standalone search tool and synchronize its availability with the selected provider.
import type { Provider, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "../../core/extensions/types.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../../core/tools/truncate.ts";
import { researchParallel } from "./parallel.ts";
import {
	fetchWeb,
	getSearchBackend,
	getXSearchBackend,
	KEYED_BACKEND_IDS,
	resolveWebSearch,
	SEARCH_LOGINS,
	type SearchBackend,
	type SearchLogin,
	searchKey,
	webFetchAvailable,
} from "./search.ts";

function credentialProvider(id: SearchLogin, name: string): Provider {
	return {
		id,
		name,
		auth: {
			apiKey: {
				name: `${name} API key`,
				login: async (interaction) => {
					interaction.signal.throwIfAborted();
					const key = (await interaction.prompt({ type: "secret", message: `Enter ${name} API key` })).trim();
					interaction.signal.throwIfAborted();
					if (!key) throw new Error(`${name} API key must not be blank.`);
					return { type: "api_key", key };
				},
				check: async ({ credential, signal }) => {
					signal.throwIfAborted();
					return credential ? { type: "api_key", source: "stored credential" } : undefined;
				},
				resolve: async ({ credential, signal }) => {
					signal.throwIfAborted();
					if (!credential) return undefined;
					const key = credential.key?.trim();
					if (!key) {
						throw new Error(
							`${name} API key could not be read. Check the stored key or its !command, or run /login ${id} again.`,
						);
					}
					return { auth: { apiKey: key }, source: "stored credential" };
				},
			},
		},
		getModels: () => [],
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) => streamSimple(model, context, options),
	};
}

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
			"Search the web for current information. Uses the selected provider when it supports web search, then the next available backend in webSearch.order when it does not or that search fails. Returns source links.",
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

const parallelToolNames = ["web_fetch", "web_research"] as const;

/** Register provider-aware web and X search without changing other tools' active states. */
export default function webSearch(pi: ExtensionAPI): void {
	for (const id of KEYED_BACKEND_IDS) pi.registerProvider(credentialProvider(id, SEARCH_LOGINS[id].name));

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
					const order = pi.getSettings().webSearch?.order;
					const backend =
						tool.name === "web_search"
							? resolveWebSearch(ctx.model?.provider, order, ctx.modelRegistry, ctx.model?.id)
							: tool.resolve(ctx.model?.provider);
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
				"Extract excerpts from public http(s) URLs with Parallel, Tavily, Exa, or Firecrawl, in webSearch.order. A failed URL is reported as an error line; a failed backend tries the next one.",
			promptSnippet: "Extract excerpts from URLs with Parallel, Tavily, Exa, or Firecrawl",
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
			async execute(_id, { urls, objective }, signal, _onUpdate, ctx) {
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
				const result = await fetchWeb(
					targets,
					objective?.trim() || undefined,
					pi.getSettings().webSearch?.order,
					ctx.modelRegistry,
					signal,
				);
				return {
					content: [{ type: "text", text: limitResult(result.text) }],
					details: result.fallbackFrom
						? { backend: result.backend, fallbackFrom: result.fallbackFrom }
						: { backend: result.backend },
				};
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
			async execute(_id, { query, effort, previous_response_id }, signal, _onUpdate, ctx) {
				const apiKey = await searchKey(ctx.modelRegistry, "parallel");
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
		const order = pi.getSettings().webSearch?.order;
		const auth = ctx.modelRegistry;
		const hasParallel = auth.getProviderAuthStatus("parallel").configured;
		for (const tool of searchTools) {
			const supported =
				(tool.name === "web_search"
					? resolveWebSearch(ctx.model?.provider, order, auth, ctx.model?.id)
					: tool.resolve(ctx.model?.provider)) !== undefined && !optedOut(tool.name);
			if (supported && !active.includes(tool.name)) {
				active = [...active, tool.name];
				changed = true;
			} else if (!supported && active.includes(tool.name)) {
				active = active.filter((name) => name !== tool.name);
				changed = true;
			}
		}
		for (const name of parallelToolNames) {
			const supported = (name === "web_fetch" ? webFetchAvailable(order, auth) : hasParallel) && !optedOut(name);
			if (supported && !active.includes(name)) {
				active = [...active, name];
				changed = true;
			} else if (!supported && active.includes(name)) {
				active = active.filter((activeName) => activeName !== name);
				changed = true;
			}
		}
		if (changed) pi.setActiveTools(active);
		seenLogins = loginState(ctx);
	};
	const loginState = (ctx: ExtensionContext) =>
		KEYED_BACKEND_IDS.map((id) => ctx.modelRegistry.getProviderAuthStatus(id).configured).join();
	let seenLogins: string | undefined;
	pi.on("session_start", (_event, ctx) => synchronize(ctx));
	pi.on("model_select", (_event, ctx) => synchronize(ctx));
	// /tree restores the branch's recorded tools but keeps the current model.
	pi.on("session_tree", (_event, ctx) => synchronize(ctx));
	// /login does not emit model_select. Sync only when that login state changed, so a manual disable stays off.
	pi.on("before_agent_start", (_event, ctx) => {
		const next = loginState(ctx);
		if (next !== seenLogins) synchronize(ctx);
	});
}
