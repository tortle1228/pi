// Search through pi's OpenAI Responses transports using the selected model and credentials.
import { normalizeContext } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { SearchResult } from "./search.ts";

/** Run a separate web search without sending the current conversation. */
export async function searchOpenAI(query: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchResult> {
	const model = ctx.model;
	if (!model || (model.provider !== "openai" && model.provider !== "openai-codex")) {
		throw new Error("OpenAI search requires the openai or openai-codex provider.");
	}
	const cancellation = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(60_000)]);
	cancellation.throwIfAborted();
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	cancellation.throwIfAborted();
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key found for ${model.provider}. Configure the provider in pi.`);

	let searched = false;
	let finalText = "";
	const urls = new Set<string>();
	const collectUrl = (value: unknown) => {
		if (typeof value !== "string") return;
		try {
			const url = new URL(value);
			if (url.protocol === "https:" || url.protocol === "http:") urls.add(value);
		} catch {
			/* Ignore invalid provider URLs. */
		}
	};
	const collectItem = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		const item = value as {
			type?: string;
			status?: string;
			action?: { sources?: { url?: unknown }[] };
			content?: { type?: string; text?: string; annotations?: { url?: unknown }[] }[];
		};
		if (item.type === "web_search_call" && item.status === "completed") {
			searched = true;
			for (const source of item.action?.sources ?? []) collectUrl(source.url);
		}
		if (item.type === "message") {
			for (const content of item.content ?? []) {
				for (const annotation of content.annotations ?? []) collectUrl(annotation.url);
			}
		}
	};
	const options = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		signal: cancellation,
		maxRetries: 0,
		transport: "sse" as const,
		cacheRetention: "none" as const,
		onPayload(payload: unknown) {
			const body = payload as Record<string, unknown>;
			const include = Array.isArray(body.include) ? body.include : [];
			return {
				...body,
				tools: [{ type: "web_search" }],
				tool_choice: "required",
				include: [...include, "web_search_call.action.sources"],
			};
		},
		onProviderStreamEvent(value: unknown) {
			if (!value || typeof value !== "object") return;
			const event = value as {
				type?: string;
				item?: unknown;
				annotation?: { url?: unknown };
				response?: { output?: unknown[] };
			};
			if (event.type === "response.output_item.done") collectItem(event.item);
			if (event.type === "response.output_text.annotation.added") collectUrl(event.annotation?.url);
			if (event.type === "response.completed" || event.type === "response.done") {
				for (const item of event.response?.output ?? []) {
					collectItem(item);
					if (
						item &&
						typeof item === "object" &&
						"type" in item &&
						item.type === "message" &&
						"content" in item &&
						Array.isArray(item.content)
					) {
						finalText += item.content
							.filter((part) => part.type === "output_text" && typeof part.text === "string")
							.map((part) => part.text)
							.join("");
					}
				}
			}
		},
	};
	const context = normalizeContext({ messages: [{ role: "user", content: query, timestamp: Date.now() }] });
	const response =
		model.provider === "openai-codex"
			? openAICodexResponsesApi().stream({ ...model, api: "openai-codex-responses" }, context, options)
			: openAIResponsesApi().stream({ ...model, api: "openai-responses" }, context, options);
	const result = await response.result();
	cancellation.throwIfAborted();
	if (result.stopReason !== "stop")
		throw new Error(result.errorMessage || `OpenAI search failed: ${result.stopReason}`);
	if (!searched) throw new Error("OpenAI did not complete a web search.");
	const text =
		result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n\n") || finalText;
	if (!text.trim()) throw new Error("OpenAI search returned no readable content.");
	return { backend: model.provider, text: urls.size ? `${text}\n\nSources:\n${[...urls].join("\n")}` : text };
}
