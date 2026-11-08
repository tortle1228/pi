import type {
	AssistantImages,
	ImageApi,
	ImageContent,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
	buildSSEHeaders,
	extractAccountId,
	parseErrorResponse,
	parseSSE,
	resolveCodexUrl,
} from "./openai-codex-responses.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const MIME_TYPES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

/** Read from `ImagesOptions.metadata`. Other `image_generation` fields (size, quality, ...) have no effect on this backend. */
export interface OpenAICodexImagesMetadata {
	outputFormat?: keyof typeof MIME_TYPES;
	/** 0-100, jpeg and webp only. */
	outputCompression?: number;
	background?: "transparent" | "opaque" | "auto";
}

interface ImageGenerationItem {
	type?: string;
	result?: string;
}

interface CodexImageEvent {
	type?: string;
	message?: string;
	item?: ImageGenerationItem;
	response?: { id?: string; error?: { message?: string } };
}

/** Image generation through the Codex Responses endpoint's `image_generation` tool (ChatGPT plan login). */
export const generateImages: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		const metadata = options?.metadata as OpenAICodexImagesMetadata | undefined;
		const format = metadata?.outputFormat ?? "png";
		if (metadata?.background === "transparent" && format === "jpeg") {
			throw new Error("Transparent backgrounds need png or webp output, not jpeg.");
		}

		let body: unknown = {
			model: model.id,
			store: false,
			stream: true,
			instructions: "You are a helpful assistant.",
			input: [
				{
					role: "user",
					content: context.input.map((item) =>
						item.type === "text"
							? { type: "input_text", text: sanitizeSurrogates(item.text) }
							: { type: "input_image", image_url: `data:${item.mimeType};base64,${item.data}` },
					),
				},
			],
			tools: [
				{
					type: "image_generation",
					output_format: format,
					...(metadata?.outputCompression !== undefined ? { output_compression: metadata.outputCompression } : {}),
					...(metadata?.background ? { background: metadata.background } : {}),
				},
			],
			tool_choice: { type: "image_generation" },
		};
		body = (await options?.onPayload?.(body, model)) ?? body;

		const headers = buildSSEHeaders(
			{ originator: "pi", ...getIdentityHeaders(model, options?.identity) },
			model.headers,
			options?.headers,
			extractAccountId(apiKey),
			apiKey,
		);
		const combined = combineAbortSignals([
			options?.signal,
			AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		]);
		try {
			const response = await (options?.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: combined.signal,
			});
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (!response.ok) {
				const info = await parseErrorResponse(response);
				throw new Error(info.friendlyMessage || info.message);
			}
			for await (const raw of parseSSE(response, combined.signal)) {
				const event = raw as CodexImageEvent;
				if (event.type === "response.created") {
					output.responseId = event.response?.id;
				} else if (event.type === "response.output_item.done") {
					if (event.item?.type === "image_generation_call" && event.item.result) {
						output.output.push({
							type: "image",
							mimeType: MIME_TYPES[format],
							data: event.item.result,
						} satisfies ImageContent);
					}
				} else if (event.type === "response.failed") {
					throw new Error(event.response?.error?.message ?? "Codex image generation failed");
				} else if (event.type === "error") {
					throw new Error(event.message ?? "Codex image generation failed");
				}
			}
		} finally {
			combined.cleanup();
		}
		if (output.output.length === 0) {
			throw new Error("Codex returned no image. Try again or rephrase the prompt.");
		}
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};
