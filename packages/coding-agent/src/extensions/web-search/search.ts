// Provider dispatch and the contract implemented by search backends.
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { searchAnthropic } from "./anthropic.ts";
import { searchOpenAI, searchX, searchXai } from "./openai.ts";
import { loadZaiSearch } from "./zai.lazy.ts";

export interface SearchResult {
	backend: string;
	text: string;
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
