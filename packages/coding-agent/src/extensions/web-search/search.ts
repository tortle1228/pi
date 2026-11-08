// Provider dispatch and the contract implemented by search backends.
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { searchAnthropic } from "./anthropic.ts";
import { searchOpenAI, searchX, searchXai } from "./openai.ts";
import { parallelApiKey, searchParallel } from "./parallel.ts";
import { loadZaiSearch } from "./zai.lazy.ts";

export interface SearchResult {
	backend: string;
	text: string;
	/** Set when a native search failed and Parallel answered instead. */
	fallbackFrom?: string;
}

export interface SearchBackend {
	search(query: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchResult>;
}

const backends: Readonly<Record<string, SearchBackend>> = {
	zai: { search: async (query, ctx, signal) => (await loadZaiSearch()).searchZai(query, ctx, signal) },
	openai: { search: searchOpenAI },
	"openai-codex": { search: searchOpenAI },
	anthropic: { search: searchAnthropic },
	xai: { search: searchXai },
};

const xBackends: Readonly<Record<string, SearchBackend>> = {
	xai: { search: searchX },
};

/** Select a search backend by provider ID, never by model name or URL. */
export function getSearchBackend(provider: string | undefined): SearchBackend | undefined {
	return provider === undefined || !Object.hasOwn(backends, provider) ? undefined : backends[provider];
}

/** Select an X post search backend by provider ID. Only xAI offers one. */
export function getXSearchBackend(provider: string | undefined): SearchBackend | undefined {
	return provider === undefined || !Object.hasOwn(xBackends, provider) ? undefined : xBackends[provider];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Native search when the provider has one, otherwise Parallel when `PARALLEL_API_KEY` is set.
 * A native failure is retried once with Parallel unless the caller cancelled.
 */
export function resolveWebSearch(provider: string | undefined): SearchBackend | undefined {
	const native = getSearchBackend(provider);
	if (!native && !parallelApiKey()) return undefined;
	return {
		async search(query, ctx, signal) {
			if (!native) {
				const apiKey = parallelApiKey();
				if (!apiKey) throw new Error("Parallel authentication required. Set PARALLEL_API_KEY.");
				return searchParallel(query, apiKey, signal);
			}
			try {
				return await native.search(query, ctx, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				const apiKey = parallelApiKey();
				if (!apiKey) throw error;
				try {
					const result = await searchParallel(query, apiKey, signal);
					return { ...result, fallbackFrom: provider };
				} catch (fallbackError) {
					if (signal?.aborted) throw fallbackError;
					throw new Error(`${errorMessage(error)}\nParallel fallback failed: ${errorMessage(fallbackError)}`);
				}
			}
		},
	};
}
