// Firecrawl Search and Scrape calls. The caller supplies the stored key.
import { isRecord, postJson, withDeadline as sharedDeadline } from "./http.ts";
import type { SearchResult } from "./search.ts";

const SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const TIMEOUT_MS = 60_000;

function errorText(payload: unknown): string | undefined {
	return isRecord(payload) && typeof payload.error === "string" && payload.error.trim()
		? payload.error.trim()
		: undefined;
}

function post(url: string, body: unknown, apiKey: string, signal: AbortSignal, label: string): Promise<unknown> {
	return postJson("Firecrawl", url, body, { authorization: `Bearer ${apiKey}` }, signal, label, errorText);
}

function withDeadline<T>(
	label: string,
	signal: AbortSignal | undefined,
	apiKey: string,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	return sharedDeadline("Firecrawl", label, TIMEOUT_MS, signal, apiKey, run);
}

/** Search the web only. Sends only the query and does not scrape result pages. */
export function searchFirecrawl(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult> {
	return withDeadline("Search", signal, apiKey, async (requestSignal) => {
		const payload = await post(SEARCH_URL, { query }, apiKey, requestSignal, "Search");
		if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.web)) {
			throw new Error("Firecrawl returned malformed search JSON.");
		}
		const blocks: string[] = [];
		for (const item of payload.data.web) {
			if (!isRecord(item) || typeof item.url !== "string") {
				throw new Error("Firecrawl returned malformed search JSON.");
			}
			const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : undefined;
			const description = typeof item.description === "string" ? item.description : "";
			blocks.push([title, item.url, description].filter((part) => part !== undefined && part.length > 0).join("\n"));
		}
		return { backend: "firecrawl", text: blocks.length > 0 ? blocks.join("\n\n") : "No results." };
	});
}

/**
 * Scrape each URL as markdown, concurrently under one deadline. A failed URL is an error line;
 * every URL failing throws so the next backend is tried. Firecrawl has no objective, so it is ignored.
 */
export function extractFirecrawl(
	urls: readonly string[],
	_objective: string | undefined,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	return withDeadline("Extract", signal, apiKey, async (requestSignal) => {
		const settled = await Promise.allSettled(
			urls.map(async (url) => {
				const payload = await post(SCRAPE_URL, { url, formats: ["markdown"] }, apiKey, requestSignal, "Scrape");
				if (!isRecord(payload) || !isRecord(payload.data)) throw new Error("malformed scrape JSON");
				const title =
					isRecord(payload.data.metadata) && typeof payload.data.metadata.title === "string"
						? payload.data.metadata.title.trim()
						: "";
				const markdown = typeof payload.data.markdown === "string" ? payload.data.markdown : "";
				return [title, url, markdown].filter((part) => part.length > 0).join("\n");
			}),
		);
		// Only the caller's cancel stops the whole call; a deadline keeps the URLs that finished.
		signal?.throwIfAborted();
		const blocks: string[] = [];
		const reasons: string[] = [];
		settled.forEach((result, index) => {
			if (result.status === "fulfilled") {
				blocks.push(result.value);
				return;
			}
			const message = requestSignal.aborted
				? "timed out"
				: result.reason instanceof Error
					? result.reason.message
					: String(result.reason);
			reasons.push(message);
			blocks.push(`Failed: ${urls[index]} (${message})`);
		});
		if (reasons.length === urls.length) throw new Error(reasons[0] ?? "Firecrawl Scrape failed.");
		return blocks.join("\n\n");
	});
}
