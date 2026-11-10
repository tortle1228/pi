// Search through pi's OpenAI Responses transports using the selected model and credentials.
import { normalizeContext } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { SearchResult } from "./search.ts";

type ResponsesSearchTool = "web_search" | "x_search";

interface ResponsesSearch {
	tool: ResponsesSearchTool;
	providers: readonly string[];
	missing: string;
	noun: string;
}

/** Run one server-side Responses search without sending the current conversation. */
async function searchResponses(
	query: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	search: ResponsesSearch,
): Promise<SearchResult> {
	const model = ctx.model;
	if (!model || !search.providers.includes(model.provider)) throw new Error(search.missing);
	const cancellation = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(60_000)]);
	cancellation.throwIfAborted();
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	cancellation.throwIfAborted();
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key found for ${model.provider}. Configure the provider in pi.`);

	const label = model.provider === "xai" ? "xAI" : "OpenAI";
	const callType = search.tool === "web_search" ? "web_search_call" : "x_search_call";
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
	let foreignTool = false;
	const collectItem = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		const item = value as {
			type?: string;
			name?: string;
			status?: string;
			action?: { sources?: { url?: unknown }[] };
			content?: { type?: string; text?: string; annotations?: { url?: unknown }[] }[];
		};
		if (item.type === callType && item.status === "completed") {
			searched = true;
			for (const source of item.action?.sources ?? []) collectUrl(source.url);
		}
		// xAI runs X search itself and reports the inner calls as custom_tool_call, not x_search_call.
		if (search.tool === "x_search" && item.type === "custom_tool_call" && item.status === "completed") {
			if (item.name?.startsWith("x_")) searched = true;
			else foreignTool = true;
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
			const lowReasoning = model.provider === "xai" && model.reasoning;
			const include = (Array.isArray(body.include) ? body.include : []).filter(
				(item) => !(lowReasoning && item === "reasoning.encrypted_content"),
			);
			const { tool_choice: _toolChoice, reasoning: previousReasoning, include: _include, ...rest } = body;
			const tools = [{ type: search.tool }];
			// Omitting effort makes grok-4.5+ default to high. "none" is not accepted there.
			const base = lowReasoning
				? { ...rest, reasoning: { effort: "low" } }
				: { ...rest, ...(previousReasoning === undefined ? {} : { reasoning: previousReasoning }) };
			// required makes xAI wait for a client tool result after its own X search.
			if (search.tool !== "web_search") return include.length > 0 ? { ...base, tools, include } : { ...base, tools };
			return { ...base, tools, tool_choice: "required", include: [...include, "web_search_call.action.sources"] };
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
	const toolCalls = result.content.filter((block) => block.type === "toolCall");
	if (search.tool === "x_search") {
		if (toolCalls.some((call) => !call.name.startsWith("x_"))) foreignTool = true;
		if (toolCalls.some((call) => call.name.startsWith("x_"))) searched = true;
	}
	if (foreignTool) throw new Error(`${label} search returned a tool call that is not an X search.`);
	const serverSideXSearch = search.tool === "x_search" && result.stopReason === "toolUse" && searched;
	if (result.stopReason !== "stop" && !serverSideXSearch)
		throw new Error(result.errorMessage || `${label} search failed: ${result.stopReason}`);
	if (!searched) throw new Error(`${label} did not complete ${search.noun}.`);
	const text =
		result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n\n") || finalText;
	if (!text.trim()) throw new Error(`${label} search returned no readable content.`);
	return { backend: model.provider, text: urls.size ? `${text}\n\nSources:\n${[...urls].join("\n")}` : text };
}

/** Run a separate web search without sending the current conversation. */
export function searchOpenAI(query: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchResult> {
	return searchResponses(query, ctx, signal, {
		tool: "web_search",
		providers: ["openai", "openai-codex"],
		missing: "OpenAI search requires the openai or openai-codex provider.",
		noun: "a web search",
	});
}

/** Run a separate xAI web search without sending the current conversation. */
export function searchXai(query: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchResult> {
	return searchResponses(query, ctx, signal, {
		tool: "web_search",
		providers: ["xai"],
		missing: "xAI search requires the xai provider.",
		noun: "a web search",
	});
}

/** Run a separate X post search without sending the current conversation. */
export function searchX(query: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchResult> {
	return searchResponses(query, ctx, signal, {
		tool: "x_search",
		providers: ["xai"],
		missing: "X search requires the xai provider.",
		noun: "an X search",
	});
}
