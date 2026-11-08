// Provider dispatch and the contract implemented by search backends.
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { searchAnthropic } from "./anthropic.ts";
import { isGeminiModel, searchAntigravity } from "./antigravity.ts";
import { extractExa, searchExa } from "./exa.ts";
import { extractFirecrawl, searchFirecrawl } from "./firecrawl.ts";
import { searchOpenAI, searchX, searchXai } from "./openai.ts";
import { extractParallel, searchParallel } from "./parallel.ts";
import { extractTavily, searchTavily } from "./tavily.ts";
import { loadZaiSearch } from "./zai.lazy.ts";

export interface SearchResult {
	backend: string;
	text: string;
	/** Set to the first backend that failed when a later one answered. Native uses the provider id. */
	fallbackFrom?: string;
}

const WEB_SEARCH_BACKENDS = ["native", "parallel", "tavily", "exa", "firecrawl"] as const;
export type WebSearchBackendId = (typeof WEB_SEARCH_BACKENDS)[number];

export interface SearchBackend {
	search(query: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchResult>;
}

const backends: Readonly<Record<string, SearchBackend>> = {
	zai: { search: async (query, ctx, signal) => (await loadZaiSearch()).searchZai(query, ctx, signal) },
	openai: { search: searchOpenAI },
	"openai-codex": { search: searchOpenAI },
	anthropic: { search: searchAnthropic },
	"anthropic-api": { search: searchAnthropic },
	"google-antigravity": { search: searchAntigravity },
	xai: { search: searchXai },
};

const xBackends: Readonly<Record<string, SearchBackend>> = {
	xai: { search: searchX },
};

/** Select a search backend by provider ID, never by URL. Antigravity also needs a Gemini model. */
export function getSearchBackend(provider: string | undefined, modelId?: string): SearchBackend | undefined {
	if (provider === "google-antigravity" && !isGeminiModel(modelId)) return undefined;
	return provider === undefined || !Object.hasOwn(backends, provider) ? undefined : backends[provider];
}

/** Select an X post search backend by provider ID. Only xAI offers one. */
export function getXSearchBackend(provider: string | undefined): SearchBackend | undefined {
	return provider === undefined || !Object.hasOwn(xBackends, provider) ? undefined : xBackends[provider];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Drop unknown and repeated entries. An unset list uses the default order. */
export function webSearchOrder(order: readonly string[] | undefined): readonly WebSearchBackendId[] {
	if (order === undefined) return SETTINGS_DEFAULTS.webSearch.order;
	const seen = new Set<string>();
	const result: WebSearchBackendId[] = [];
	for (const id of order) {
		if (!(WEB_SEARCH_BACKENDS as readonly string[]).includes(id) || seen.has(id)) continue;
		seen.add(id);
		result.push(id as WebSearchBackendId);
	}
	return result;
}

interface Attempt<T> {
	/** Recorded as `fallbackFrom` when this attempt is the first failure. */
	name: string;
	/** Used in "<label> fallback failed". */
	label: string;
	run(): Promise<T>;
}

/** Try each attempt once. A cancellation stops the chain; other failures try the next attempt. */
async function firstSuccess<T>(
	attempts: readonly Attempt<T>[],
	signal?: AbortSignal,
): Promise<{ value: T; fallbackFrom?: string }> {
	let failure = "";
	let fallbackFrom: string | undefined;
	for (const attempt of attempts) {
		try {
			return { value: await attempt.run(), ...(fallbackFrom ? { fallbackFrom } : {}) };
		} catch (error) {
			if (signal?.aborted) throw error;
			if (!fallbackFrom) {
				fallbackFrom = attempt.name;
				failure = errorMessage(error);
				continue;
			}
			failure += `\n${attempt.label} fallback failed: ${errorMessage(error)}`;
		}
	}
	throw new Error(failure || "No web search backend is available.");
}

export type SearchAuth = Pick<ExtensionContext["modelRegistry"], "getProviderAuthStatus" | "getProviderAuth">;

export const SEARCH_LOGINS = {
	parallel: { name: "Parallel", missing: "Parallel authentication required. Run /login parallel." },
	tavily: { name: "Tavily", missing: "Tavily authentication required. Run /login tavily." },
	exa: { name: "Exa", missing: "Exa authentication required. Run /login exa." },
	firecrawl: { name: "Firecrawl", missing: "Firecrawl authentication required. Run /login firecrawl." },
} as const;

export type SearchLogin = keyof typeof SEARCH_LOGINS;

const KEYED_BACKENDS = {
	parallel: { search: searchParallel, extract: extractParallel },
	tavily: { search: searchTavily, extract: extractTavily },
	exa: { search: searchExa, extract: extractExa },
	firecrawl: { search: searchFirecrawl, extract: extractFirecrawl },
} satisfies Record<SearchLogin, unknown>;

export const KEYED_BACKEND_IDS = Object.keys(SEARCH_LOGINS) as SearchLogin[];

function configured(auth: SearchAuth, id: SearchLogin): boolean {
	return auth.getProviderAuthStatus(id).configured;
}

/** The stored key. A read failure keeps its cause; a missing login names `/login`. */
export async function searchKey(auth: SearchAuth, id: SearchLogin): Promise<string> {
	let result: Awaited<ReturnType<SearchAuth["getProviderAuth"]>>;
	try {
		result = await auth.getProviderAuth(id);
	} catch (error) {
		throw new Error(errorMessage(error));
	}
	const key = result?.auth.apiKey?.trim();
	if (!key) throw new Error(SEARCH_LOGINS[id].missing);
	return key;
}

/**
 * Search backends in `order`, skipping one that is unavailable. A failure tries the next one
 * unless the caller cancelled. Keys are read when the call starts.
 */
export function resolveWebSearch(
	provider: string | undefined,
	order: readonly string[] | undefined,
	auth: SearchAuth,
	modelId?: string,
): SearchBackend | undefined {
	const available = webSearchOrder(order).some((id) => {
		if (id === "native") return getSearchBackend(provider, modelId) !== undefined;
		return configured(auth, id);
	});
	if (!available) return undefined;
	return {
		async search(query, ctx, signal) {
			const attempts: Attempt<SearchResult>[] = [];
			for (const id of webSearchOrder(order)) {
				if (id === "native") {
					const native = getSearchBackend(provider, modelId);
					if (!native) continue;
					attempts.push({
						name: provider ?? "native",
						label: provider ?? "native",
						run: () => native.search(query, ctx, signal),
					});
				} else if (configured(ctx.modelRegistry, id)) {
					const login = id;
					attempts.push({
						name: login,
						label: SEARCH_LOGINS[login].name,
						run: async () => {
							const apiKey = await searchKey(ctx.modelRegistry, login);
							return KEYED_BACKENDS[login].search(query, apiKey, signal);
						},
					});
				}
			}
			if (attempts.length === 0) throw new Error("No web search backend is available.");
			const { value, fallbackFrom } = await firstSuccess(attempts, signal);
			return fallbackFrom ? { ...value, fallbackFrom } : value;
		},
	};
}

/** True when `order` names a fetch backend whose stored key is set. */
export function webFetchAvailable(order: readonly string[] | undefined, auth: SearchAuth): boolean {
	return webSearchOrder(order).some((id) => id !== "native" && configured(auth, id));
}

/** Extract URLs with the same order and fallback rules as web search. `native` is skipped. */
export async function fetchWeb(
	urls: readonly string[],
	objective: string | undefined,
	order: readonly string[] | undefined,
	auth: SearchAuth,
	signal?: AbortSignal,
): Promise<{ backend: string; text: string; fallbackFrom?: string }> {
	const attempts: Attempt<{ backend: string; text: string }>[] = [];
	for (const id of webSearchOrder(order)) {
		if (id === "native" || !configured(auth, id)) continue;
		const login = id;
		attempts.push({
			name: login,
			label: SEARCH_LOGINS[login].name,
			run: async () => {
				const apiKey = await searchKey(auth, login);
				const text = await KEYED_BACKENDS[login].extract(urls, objective, apiKey, signal);
				return { backend: login, text };
			},
		});
	}
	if (attempts.length === 0) {
		throw new Error(
			"Web fetch requires a saved key. Run /login parallel, /login tavily, /login exa, or /login firecrawl.",
		);
	}
	const { value, fallbackFrom } = await firstSuccess(attempts, signal);
	return fallbackFrom ? { ...value, fallbackFrom } : value;
}
