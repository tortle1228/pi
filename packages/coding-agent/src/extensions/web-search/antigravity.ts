// Search through pi's Antigravity transport using Google Search grounding on the selected Gemini model.
import { normalizeContext } from "@earendil-works/pi-ai";
import { googleAntigravityApi } from "@earendil-works/pi-ai/api/google-antigravity.lazy";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { SearchResult } from "./search.ts";

/** Only Gemini models accept the googleSearch tool; Claude and GPT-OSS on Antigravity do not. */
export function isGeminiModel(modelId: string | undefined): boolean {
	return modelId?.startsWith("gemini-") === true;
}

/** Run a separate web search without sending the current conversation. */
export async function searchAntigravity(
	query: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<SearchResult> {
	const model = ctx.model;
	if (!model || model.provider !== "google-antigravity" || !isGeminiModel(model.id)) {
		throw new Error("Antigravity search requires a Gemini model.");
	}
	const cancellation = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(60_000)]);
	cancellation.throwIfAborted();
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	cancellation.throwIfAborted();
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key found for ${model.provider}. Configure the provider in pi.`);

	let searched = false;
	const urls = new Set<string>();
	const options = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		signal: cancellation,
		maxRetries: 0,
		cacheRetention: "none" as const,
		onPayload(payload: unknown) {
			const body = payload as { request: Record<string, unknown> };
			const { toolConfig: _toolConfig, ...request } = body.request;
			return { ...body, request: { ...request, tools: [{ googleSearch: {} }] } };
		},
		onProviderStreamEvent(value: unknown) {
			const grounding = (
				value as {
					candidates?: {
						groundingMetadata?: {
							webSearchQueries?: unknown[];
							groundingChunks?: { web?: { uri?: unknown } }[];
						};
					}[];
				}
			).candidates?.[0]?.groundingMetadata;
			if (!grounding) return;
			if (grounding.webSearchQueries?.length) searched = true;
			for (const chunk of grounding.groundingChunks ?? []) {
				const uri = chunk.web?.uri;
				if (typeof uri !== "string") continue;
				try {
					const url = new URL(uri);
					if (url.protocol === "https:" || url.protocol === "http:") {
						urls.add(uri);
						searched = true;
					}
				} catch {
					/* Ignore invalid provider URLs. */
				}
			}
		},
	};
	const context = normalizeContext({ messages: [{ role: "user", content: query, timestamp: Date.now() }] });
	const result = await googleAntigravityApi()
		.stream({ ...model, api: "google-antigravity" }, context, options)
		.result();
	cancellation.throwIfAborted();
	if (result.stopReason !== "stop") {
		throw new Error(result.errorMessage || `Antigravity search failed: ${result.stopReason}`);
	}
	if (!searched) throw new Error("Antigravity did not complete a web search.");
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
	if (!text.trim()) throw new Error("Antigravity search returned no readable content.");
	return {
		backend: "google-antigravity",
		text: urls.size ? `${text}\n\nSources:\n${[...urls].join("\n")}` : text,
	};
}
