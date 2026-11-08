// Exa Search and Contents calls. The caller supplies the stored key.
import { isRecord, postJson, withDeadline as sharedDeadline } from "./http.ts";
import type { SearchResult } from "./search.ts";

const SEARCH_URL = "https://api.exa.ai/search";
const CONTENTS_URL = "https://api.exa.ai/contents";
const TIMEOUT_MS = 60_000;

function errorText(payload: unknown): string | undefined {
	return isRecord(payload) && typeof payload.error === "string" && payload.error.trim()
		? payload.error.trim()
		: undefined;
}

function post(url: string, body: unknown, apiKey: string, signal: AbortSignal, label: string): Promise<unknown> {
	return postJson("Exa", url, body, { "x-api-key": apiKey }, signal, label, errorText);
}

function withDeadline<T>(
	label: string,
	signal: AbortSignal | undefined,
	apiKey: string,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	return sharedDeadline("Exa", label, TIMEOUT_MS, signal, apiKey, run);
}

function renderResults(payload: unknown, kind: string): string[] {
	if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error(`Exa returned malformed ${kind} JSON.`);
	const blocks: string[] = [];
	for (const item of payload.results) {
		if (!isRecord(item) || typeof item.url !== "string") throw new Error(`Exa returned malformed ${kind} JSON.`);
		const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : undefined;
		const highlights = Array.isArray(item.highlights)
			? item.highlights.filter((part): part is string => typeof part === "string")
			: [];
		const body = highlights.length > 0 ? highlights.join("\n\n") : typeof item.text === "string" ? item.text : "";
		blocks.push([title, item.url, body].filter((part) => part !== undefined && part.length > 0).join("\n"));
	}
	return blocks;
}

/** Search with Exa `auto` type and highlights. Sends only the query. */
export function searchExa(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult> {
	return withDeadline("Search", signal, apiKey, async (requestSignal) => {
		const payload = await post(
			SEARCH_URL,
			{ query, type: "auto", contents: { highlights: true } },
			apiKey,
			requestSignal,
			"Search",
		);
		const blocks = renderResults(payload, "search");
		return { backend: "exa", text: blocks.length > 0 ? blocks.join("\n\n") : "No results." };
	});
}

/** Extract up to 20 URLs. A failed URL is an error line, not a thrown error. */
export function extractExa(
	urls: readonly string[],
	objective: string | undefined,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	return withDeadline("Extract", signal, apiKey, async (requestSignal) => {
		const payload = await post(
			CONTENTS_URL,
			objective ? { urls, highlights: { query: objective } } : { urls, text: true },
			apiKey,
			requestSignal,
			"Extract",
		);
		const blocks = renderResults(payload, "extract");
		if (isRecord(payload) && Array.isArray(payload.statuses)) {
			for (const status of payload.statuses) {
				if (!isRecord(status) || status.status !== "error" || typeof status.id !== "string") continue;
				const tag = isRecord(status.error) && typeof status.error.tag === "string" ? status.error.tag : "error";
				blocks.push(`Failed: ${status.id} (${tag})`);
			}
		}
		return blocks.length > 0 ? blocks.join("\n\n") : "No results.";
	});
}
