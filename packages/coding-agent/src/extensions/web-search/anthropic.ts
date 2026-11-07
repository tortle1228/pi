// Search through pi's Anthropic Messages transport using the selected model and credentials.
import { normalizeContext } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { SearchResult } from "./search.ts";

/** Run a separate web search without sending the current conversation. */
export async function searchAnthropic(
	query: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<SearchResult> {
	const model = ctx.model;
	if (!model || model.provider !== "anthropic") {
		throw new Error("Anthropic search requires the anthropic provider.");
	}
	const cancellation = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(60_000)]);
	cancellation.throwIfAborted();
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	cancellation.throwIfAborted();
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key found for ${model.provider}. Configure the provider in pi.`);

	let searched = false;
	let searchError: string | undefined;
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
	const collectBlock = (value: unknown) => {
		if (!value || typeof value !== "object" || !("type" in value) || value.type !== "web_search_tool_result") return;
		const content = "content" in value ? value.content : undefined;
		if (Array.isArray(content)) {
			searched = true;
			for (const item of content) {
				if (item && typeof item === "object" && "url" in item) collectUrl(item.url);
			}
			return;
		}
		if (
			content &&
			typeof content === "object" &&
			"type" in content &&
			content.type === "web_search_tool_result_error"
		) {
			searchError =
				"error_code" in content && typeof content.error_code === "string" ? content.error_code : "unknown";
		}
	};
	const options = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		signal: cancellation,
		maxRetries: 0,
		cacheRetention: "none" as const,
		// Disable thinking where the model allows it. Models that reject that still send an effort marker, whose default is high.
		thinkingEnabled: false,
		effort: "low",
		onPayload(payload: unknown) {
			const body = payload as Record<string, unknown>;
			return { ...body, tools: [{ type: "web_search_20260209", name: "web_search" }] };
		},
		onProviderStreamEvent(value: unknown) {
			if (!value || typeof value !== "object") return;
			const event = value as {
				type?: string;
				content_block?: unknown;
				delta?: { type?: string; citation?: { type?: string; url?: unknown } };
			};
			if (event.type === "content_block_start") collectBlock(event.content_block);
			if (
				event.type === "content_block_delta" &&
				event.delta?.type === "citations_delta" &&
				event.delta.citation?.type === "web_search_result_location"
			) {
				collectUrl(event.delta.citation.url);
			}
		},
	};
	const context = normalizeContext({ messages: [{ role: "user", content: query, timestamp: Date.now() }] });
	const result = await anthropicMessagesApi()
		.stream({ ...model, api: "anthropic-messages" }, context, options)
		.result();
	cancellation.throwIfAborted();
	if (searchError) throw new Error(`Anthropic search failed: ${searchError}`);
	if (result.stopReason !== "stop") {
		throw new Error(result.errorMessage || `Anthropic search failed: ${result.stopReason}`);
	}
	if (!searched) throw new Error("Anthropic did not complete a web search.");
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
	if (!text.trim()) throw new Error("Anthropic search returned no readable content.");
	return { backend: "anthropic", text: urls.size ? `${text}\n\nSources:\n${[...urls].join("\n")}` : text };
}
