// Tavily Search and Extract calls. The caller supplies the stored key.
import type { SearchResult } from "./search.ts";

const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";
const TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redact(error: unknown, apiKey: string): Error {
	const message = error instanceof Error ? error.message : String(error);
	const redacted = apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message;
	return new Error(redacted.trim() || "Tavily request failed");
}

function errorText(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
	if (isRecord(payload.error) && typeof payload.error.message === "string" && payload.error.message.trim()) {
		return payload.error.message.trim();
	}
	return undefined;
}

async function tavilyPost(
	url: string,
	body: unknown,
	apiKey: string,
	signal: AbortSignal,
	label: string,
): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
		redirect: "error",
	});
	if (!response.ok) {
		let message = response.statusText || "request failed";
		try {
			message = errorText(await response.json()) ?? message;
		} catch {
			/* A non-JSON error body still reports the status. */
		}
		throw new Error(`Tavily ${label} request failed (${response.status}): ${message}`);
	}
	try {
		return await response.json();
	} catch {
		throw new Error(`Tavily returned malformed ${label.toLowerCase()} JSON.`);
	}
}

async function withDeadline<T>(
	label: string,
	signal: AbortSignal | undefined,
	apiKey: string,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (signal?.aborted) throw new Error(`Tavily ${label} cancelled.`);
	const deadline = AbortSignal.timeout(TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	try {
		return await run(requestSignal);
	} catch (error) {
		if (signal?.aborted) throw new Error(`Tavily ${label} cancelled.`);
		if (deadline.aborted) throw new Error(`Tavily ${label} timed out after ${TIMEOUT_MS / 1000} seconds.`);
		throw redact(error, apiKey);
	}
}

function renderSearch(payload: unknown): string {
	if (!isRecord(payload) || !Array.isArray(payload.results)) {
		throw new Error("Tavily returned malformed search JSON.");
	}
	const blocks: string[] = [];
	for (const item of payload.results) {
		if (!isRecord(item) || typeof item.url !== "string") throw new Error("Tavily returned malformed search JSON.");
		const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : undefined;
		const content = typeof item.content === "string" ? item.content : "";
		blocks.push([title, item.url, content].filter((part) => part !== undefined && part.length > 0).join("\n"));
	}
	return blocks.length > 0 ? blocks.join("\n\n") : "No results.";
}

/** Search with Tavily `basic` depth. Sends only the query. */
export function searchTavily(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult> {
	return withDeadline("Search", signal, apiKey, async (requestSignal) => {
		const payload = await tavilyPost(SEARCH_URL, { query, search_depth: "basic" }, apiKey, requestSignal, "Search");
		return { backend: "tavily", text: renderSearch(payload) };
	});
}

function renderExtract(payload: unknown): string {
	if (!isRecord(payload) || !Array.isArray(payload.results)) {
		throw new Error("Tavily returned malformed extract JSON.");
	}
	const blocks: string[] = [];
	for (const item of payload.results) {
		if (!isRecord(item) || typeof item.url !== "string") throw new Error("Tavily returned malformed extract JSON.");
		const body = typeof item.raw_content === "string" ? item.raw_content : "";
		blocks.push([item.url, body].filter((part) => part.length > 0).join("\n"));
	}
	if (Array.isArray(payload.failed_results)) {
		for (const error of payload.failed_results) {
			if (!isRecord(error) || typeof error.url !== "string") continue;
			const message = typeof error.error === "string" && error.error.trim() ? error.error.trim() : "error";
			blocks.push(`Failed: ${error.url} (${message})`);
		}
	}
	return blocks.length > 0 ? blocks.join("\n\n") : "No results.";
}

/** Extract up to 20 URLs. A failed URL is an error line, not a thrown error. */
export function extractTavily(
	urls: readonly string[],
	objective: string | undefined,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	return withDeadline("Extract", signal, apiKey, async (requestSignal) => {
		const payload = await tavilyPost(
			EXTRACT_URL,
			objective ? { urls, query: objective } : { urls },
			apiKey,
			requestSignal,
			"Extract",
		);
		return renderExtract(payload);
	});
}
