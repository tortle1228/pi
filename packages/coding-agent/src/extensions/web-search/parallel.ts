// Parallel Search, Extract, and Responses calls. The caller supplies the stored key.
import { isRecord, postJson, withDeadline as sharedDeadline } from "./http.ts";
import type { SearchResult } from "./search.ts";

const SEARCH_URL = "https://api.parallel.ai/v1/search";
const EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const RESPONSES_URL = "https://api.parallel.ai/v1/responses";
const SEARCH_TIMEOUT_MS = 60_000;
const RESEARCH_TIMEOUT_MS = 120_000;

function errorText(payload: unknown): string | undefined {
	if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
		return payload.error.message;
	}
	if (isRecord(payload) && Array.isArray(payload.detail)) {
		const messages = payload.detail.flatMap((item) =>
			isRecord(item) && typeof item.msg === "string" && item.msg.trim() ? [item.msg.trim()] : [],
		);
		if (messages.length > 0) return messages.join("; ");
	}
	return undefined;
}

function post(url: string, body: unknown, apiKey: string, signal: AbortSignal, label: string): Promise<unknown> {
	return postJson("Parallel", url, body, { "x-api-key": apiKey }, signal, label, errorText);
}

function withDeadline<T>(
	ms: number,
	label: string,
	signal: AbortSignal | undefined,
	apiKey: string,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	return sharedDeadline("Parallel", label, ms, signal, apiKey, run);
}

function httpUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
	} catch {
		return undefined;
	}
}

function renderSearch(payload: unknown): string {
	if (!isRecord(payload) || !Array.isArray(payload.results)) {
		throw new Error("Parallel returned malformed search JSON.");
	}
	const blocks: string[] = [];
	for (const item of payload.results) {
		if (!isRecord(item) || typeof item.url !== "string" || !Array.isArray(item.excerpts)) {
			throw new Error("Parallel returned malformed search JSON.");
		}
		const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : item.url;
		const excerpts = item.excerpts.filter((part): part is string => typeof part === "string");
		blocks.push([title, item.url, ...excerpts].join("\n"));
	}
	return blocks.length > 0 ? blocks.join("\n\n") : "No results.";
}

/** Search with Parallel `fast` mode. The query is both the objective and the only keyword query. */
export function searchParallel(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult> {
	return withDeadline(SEARCH_TIMEOUT_MS, "Search", signal, apiKey, async (requestSignal) => {
		const payload = await post(
			SEARCH_URL,
			{ objective: query, search_queries: [query], mode: "fast" },
			apiKey,
			requestSignal,
			"Search",
		);
		return { backend: "parallel", text: renderSearch(payload) };
	});
}

function renderExtract(payload: unknown): string {
	if (!isRecord(payload) || !Array.isArray(payload.results)) {
		throw new Error("Parallel returned malformed extract JSON.");
	}
	const blocks: string[] = [];
	for (const item of payload.results) {
		if (!isRecord(item) || typeof item.url !== "string" || !Array.isArray(item.excerpts)) {
			throw new Error("Parallel returned malformed extract JSON.");
		}
		const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : item.url;
		const excerpts = item.excerpts.filter((part): part is string => typeof part === "string");
		const body =
			excerpts.length > 0 ? excerpts.join("\n\n") : typeof item.full_content === "string" ? item.full_content : "";
		blocks.push([title, item.url, body].filter((part) => part.length > 0).join("\n"));
	}
	if (Array.isArray(payload.errors)) {
		for (const error of payload.errors) {
			if (!isRecord(error) || typeof error.url !== "string") continue;
			const kind = typeof error.error_type === "string" ? error.error_type : "error";
			const status = typeof error.http_status_code === "number" ? ` ${error.http_status_code}` : "";
			blocks.push(`Failed: ${error.url} (${kind}${status})`);
		}
	}
	return blocks.length > 0 ? blocks.join("\n\n") : "No results.";
}

/** Extract excerpts from up to 20 URLs. A failed URL is an error line, not a thrown error. */
export function extractParallel(
	urls: readonly string[],
	objective: string | undefined,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	return withDeadline(SEARCH_TIMEOUT_MS, "Extract", signal, apiKey, async (requestSignal) => {
		const payload = await post(
			EXTRACT_URL,
			objective ? { urls, objective } : { urls },
			apiKey,
			requestSignal,
			"Extract",
		);
		return renderExtract(payload);
	});
}

function renderResearch(payload: unknown): string {
	if (!isRecord(payload)) throw new Error("Parallel returned a response that was not completed.");
	if (payload.status === "failed") {
		const message =
			isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message.trim() : "";
		throw new Error(message || "Parallel research failed.");
	}
	if ((payload.status !== "completed" && payload.status !== "incomplete") || !Array.isArray(payload.output)) {
		throw new Error("Parallel returned a response that was not completed.");
	}
	const texts: string[] = [];
	const sources: string[] = [];
	for (const item of payload.output) {
		if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const content of item.content) {
			if (!isRecord(content) || content.type !== "output_text" || typeof content.text !== "string") continue;
			texts.push(content.text);
			if (!Array.isArray(content.annotations)) continue;
			for (const citation of content.annotations) {
				if (!isRecord(citation) || citation.type !== "url_citation") continue;
				const url = httpUrl(citation.url);
				if (url) sources.push(url);
			}
		}
	}
	const answer = texts.join("\n\n").trim();
	if (!answer) throw new Error("Parallel returned an empty research response.");
	const parts = [answer];
	const unique = [...new Set(sources)];
	if (unique.length > 0) parts.push(`Sources:\n${unique.join("\n")}`);
	if (typeof payload.id === "string" && payload.id.trim()) parts.push(`Response ID: ${payload.id}`);
	if (payload.status === "incomplete") {
		const reason =
			isRecord(payload.incomplete_details) && typeof payload.incomplete_details.reason === "string"
				? payload.incomplete_details.reason
				: undefined;
		parts.push(reason ? `Incomplete: ${reason}` : "Incomplete.");
	}
	return parts.join("\n\n");
}

/** Synthesize a cited answer. `previous_response_id` is omitted when absent. */
export function researchParallel(
	query: string,
	effort: string,
	previousResponseId: string | undefined,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	if (effort !== "low" && effort !== "medium" && effort !== "high") {
		throw new Error("Parallel Research effort must be low, medium, or high.");
	}
	return withDeadline(RESEARCH_TIMEOUT_MS, "Research", signal, apiKey, async (requestSignal) => {
		const payload = await post(
			RESPONSES_URL,
			{
				model: "parallel",
				input: query,
				reasoning: { effort },
				stream: false,
				...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
			},
			apiKey,
			requestSignal,
			"Research",
		);
		return renderResearch(payload);
	});
}
