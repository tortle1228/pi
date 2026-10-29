/**
 * Google Antigravity adapter.
 *
 * Streams Gemini, Claude, and GPT-OSS models through the Antigravity Cloud Code
 * Assist endpoint. Every request is wrapped in the Antigravity client envelope
 * (`project`, `model`, `request`, `requestType`), and the SSE response carries
 * `{ response: ... }` chunks.
 */

import type { Content, Part, ThinkingConfig } from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { ANTIGRAVITY_ENDPOINT, getAntigravityUserAgent } from "../utils/antigravity.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { sleep } from "../utils/sleep.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import type { GoogleApiThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	getDisabledGoogleThinkingConfig,
	googleThinkingBudget,
	isThinkingPart,
	mapStopReasonString,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
	supportsGoogleStrictToolSampling,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import { buildBaseOptions, clampReasoning } from "./simple-options.ts";

export interface GoogleAntigravityOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		/** Thinking budget in tokens. Used by Claude, GPT-OSS, and Gemini 2.x models. */
		budgetTokens?: number;
		/** Thinking level. Used by Gemini 3+ models. */
		level?: GoogleApiThinkingLevel;
	};
}

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding." +
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question." +
	"**Absolute paths only**" +
	"**Proactiveness**";
const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_EMPTY_STREAM_RETRIES = 2;
const EMPTY_STREAM_BASE_DELAY_MS = 500;
const MIN_ANSWER_TOKENS = 1024;
const NEVER_ABORTED = new AbortController().signal;

let toolCallCounter = 0;

interface AntigravityCredentials {
	token: string;
	projectId: string;
}

interface AntigravityRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role: "user"; parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: ReturnType<typeof convertTools>;
		toolConfig?: { functionCallingConfig: { mode: ReturnType<typeof resolveGoogleFunctionCallingMode> } };
	};
	requestType: "agent";
	userAgent: "antigravity";
	requestId: string;
}

interface AntigravityResponseChunk {
	response?: {
		candidates?: Array<{
			content?: { role?: string; parts?: Part[] };
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		responseId?: string;
	};
}

export const stream: StreamFunction<"google-antigravity", GoogleAntigravityOptions> = (
	model: Model<"google-antigravity">,
	context: TranscriptContext,
	options?: GoogleAntigravityOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-antigravity" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const credentials = parseCredentials(options?.apiKey);
			const requestFetch = options?.fetch ?? globalThis.fetch;
			let body = buildRequest(model, normalizedContext, credentials.projectId, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as AntigravityRequest;
			}
			const url = `${(model.baseUrl || ANTIGRAVITY_ENDPOINT).replace(/\/+$/, "")}/v1internal:streamGenerateContent?alt=sse`;
			const headers = requestHeaders(model, credentials.token, options);

			let response = await requestWithRetries(requestFetch, url, headers, JSON.stringify(body), options);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			let started = false;
			const ensureStarted = () => {
				if (started) return;
				started = true;
				stream.push({ type: "start", partial: output });
			};
			let receivedContent = false;
			for (let attempt = 0; attempt <= MAX_EMPTY_STREAM_RETRIES; attempt++) {
				if (attempt > 0) {
					await sleep(EMPTY_STREAM_BASE_DELAY_MS * 2 ** (attempt - 1), options?.signal ?? NEVER_ABORTED);
					response = await requestWithRetries(requestFetch, url, headers, JSON.stringify(body), options);
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);
				}

				if (await readResponseBody(response, model, stream, output, ensureStarted, options)) {
					receivedContent = true;
					break;
				}
				resetOutput(output);
			}

			if (!receivedContent) {
				throw new Error("Antigravity API returned an empty response");
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "pending") {
				throw new Error("Antigravity stream ended without a finish reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(
					output.rawStopReason ? `Provider stopped with: ${output.rawStopReason}` : "Unknown stop reason",
				);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-antigravity", SimpleStreamOptions> = (
	model: Model<"google-antigravity">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies GoogleAntigravityOptions;

	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleAntigravityOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	if (clampedReasoning === "off") {
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleAntigravityOptions);
	}

	const resolvedLevel = resolveGoogleThinkingLevel(model, clampReasoning(clampedReasoning)!);
	if (usesGoogleThinkingLevel(model)) {
		return stream(model, context, {
			...base,
			thinking: { enabled: true, level: toGoogleThinkingLevel(resolvedLevel) },
		} satisfies GoogleAntigravityOptions);
	}

	const thinkingBudget = googleThinkingBudget(resolvedLevel, options.thinkingBudgets);
	const maxTokens = Math.min((base.maxTokens ?? 0) + thinkingBudget, model.maxTokens);
	return stream(model, context, {
		...base,
		maxTokens,
		thinking: {
			enabled: true,
			budgetTokens: maxTokens <= thinkingBudget ? Math.max(0, maxTokens - MIN_ANSWER_TOKENS) : thinkingBudget,
		},
	} satisfies GoogleAntigravityOptions);
};

function parseCredentials(apiKey: string | undefined): AntigravityCredentials {
	if (!apiKey) {
		throw new Error("Antigravity requires OAuth authentication. Use /login to authenticate.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(apiKey);
	} catch {
		throw new Error("Invalid Antigravity credentials. Use /login to re-authenticate.");
	}
	const record = parsed as { token?: unknown; projectId?: unknown };
	if (
		typeof record.token !== "string" ||
		record.token.length === 0 ||
		typeof record.projectId !== "string" ||
		record.projectId.length === 0
	) {
		throw new Error("Missing token or projectId in Antigravity credentials. Use /login to re-authenticate.");
	}
	return { token: record.token, projectId: record.projectId };
}

function isClaudeThinkingModel(model: Model<"google-antigravity">): boolean {
	return model.id.startsWith("claude-") && model.reasoning;
}

function requestHeaders(
	model: Model<"google-antigravity">,
	token: string,
	options?: GoogleAntigravityOptions,
): Record<string, string> {
	return (
		providerHeadersToRecord(
			{
				authorization: `Bearer ${token}`,
				accept: "text/event-stream",
				"content-type": "application/json",
				"user-agent": getAntigravityUserAgent(),
			},
			isClaudeThinkingModel(model) ? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER } : undefined,
			model.headers,
			options?.headers,
		) ?? {}
	);
}

function buildRequest(
	model: Model<"google-antigravity">,
	context: TranscriptContext,
	projectId: string,
	options?: GoogleAntigravityOptions,
): AntigravityRequest {
	const currentTools = getCurrentTools(context.messages);
	const generationConfig: NonNullable<AntigravityRequest["request"]["generationConfig"]> = {};
	if (options?.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options?.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}
	if (options?.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		generationConfig.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options?.thinking && !options.thinking.enabled) {
		generationConfig.thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}

	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const systemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const supportsStrictTools = supportsGoogleStrictToolSampling(model.id);
	const functionCallingMode =
		currentTools.length > 0
			? resolveGoogleFunctionCallingMode(currentTools, options?.toolChoice, supportsStrictTools)
			: undefined;

	const request: AntigravityRequest["request"] = {
		contents: convertMessages(model, context),
		systemInstruction: {
			role: "user",
			parts: [
				{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
				...(systemText ? [{ text: sanitizeSurrogates(systemText) }] : []),
			],
		},
		...(options?.sessionId ? { sessionId: options.sessionId } : {}),
		...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
		...(currentTools.length > 0 && {
			// Cloud Code Assist translates `parameters` into Anthropic's input_schema for Claude.
			tools: convertTools(currentTools, model.id.startsWith("claude-"), supportsStrictTools),
		}),
		...(functionCallingMode !== undefined && {
			toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
		}),
	};

	return {
		project: projectId,
		model: model.id,
		request,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `agent-${crypto.randomUUID()}`,
	};
}

async function requestWithRetries(
	requestFetch: typeof globalThis.fetch,
	url: string,
	headers: Record<string, string>,
	body: string,
	options?: GoogleAntigravityOptions,
): Promise<Response> {
	const maxRetries = options?.maxRetries ?? MAX_RETRIES;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (options?.signal?.aborted) {
			throw new Error("Request was aborted");
		}
		const timeoutSignal =
			options?.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
		const combinedSignal = combineAbortSignals([options?.signal, timeoutSignal]);
		let response: Response;
		try {
			response = await requestFetch(url, {
				method: "POST",
				headers,
				body,
				signal: combinedSignal.signal,
			});
		} catch (error) {
			if (timeoutSignal?.aborted && !options?.signal?.aborted) {
				throw new Error(`Antigravity request timed out after ${options?.timeoutMs}ms`);
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt >= maxRetries) throw lastError;
			await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal ?? NEVER_ABORTED);
			continue;
		} finally {
			combinedSignal.cleanup();
		}

		if (response.ok) return response;

		const errorText = await response.text();
		const message = `Antigravity API error (${response.status}): ${extractErrorMessage(errorText)}`;
		if (attempt >= maxRetries || !isRetryableError(response.status, errorText)) {
			throw new Error(message);
		}
		const serverDelay = extractRetryDelay(errorText, response);
		const maxDelayMs = options?.maxRetryDelayMs ?? 60_000;
		if (serverDelay !== undefined && maxDelayMs > 0 && serverDelay > maxDelayMs) {
			throw new Error(
				`Server requested ${Math.ceil(serverDelay / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${message}`,
			);
		}
		await sleep(serverDelay ?? BASE_DELAY_MS * 2 ** attempt, options?.signal ?? NEVER_ABORTED);
		lastError = new Error(message);
	}

	throw lastError ?? new Error("Antigravity request failed");
}

/** Reads one SSE response. Returns false when it carried no content, so the caller can retry. */
async function readResponseBody(
	response: Response,
	model: Model<"google-antigravity">,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	ensureStarted: () => void,
	options?: GoogleAntigravityOptions,
): Promise<boolean> {
	if (!response.body) {
		throw new Error("Antigravity response had no body");
	}

	let hasContent = false;
	let currentBlock: TextContent | ThinkingContent | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const abortHandler = () => {
		void reader.cancel().catch(() => {});
	};
	options?.signal?.addEventListener("abort", abortHandler);

	try {
		while (true) {
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const json = line.slice(5).trim();
				if (!json) continue;

				let chunk: AntigravityResponseChunk;
				try {
					chunk = JSON.parse(json) as AntigravityResponseChunk;
				} catch {
					continue;
				}
				const data = chunk.response;
				if (!data) continue;
				await options?.onProviderStreamEvent?.(data, model);
				output.responseId ||= data.responseId;

				const candidate = data.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						// Empty parts carry nothing to show; keep them only when a signature rides on them.
						if (part.text !== undefined && (part.text.length > 0 || part.thoughtSignature)) {
							if (part.text.length > 0) hasContent = true;
							const isThinking = isThinkingPart(part);
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blockIndex(),
											content: currentBlock.text,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
								}
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									ensureStarted();
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									ensureStarted();
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								currentBlock.text += part.text;
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}

						if (part.functionCall) {
							hasContent = true;
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
								currentBlock = null;
							}

							const providedId = part.functionCall.id;
							const needsNewId =
								!providedId ||
								output.content.some((block) => block.type === "toolCall" && block.id === providedId);
							const toolCall: ToolCall = {
								type: "toolCall",
								id: needsNewId
									? `${part.functionCall.name || "tool"}_${Date.now()}_${++toolCallCounter}`
									: providedId,
								name: part.functionCall.name || "",
								arguments: (part.functionCall.args ?? {}) as ToolCall["arguments"],
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};
							output.content.push(toolCall);
							ensureStarted();
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: JSON.stringify(toolCall.arguments),
								partial: output,
							});
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReasonString(candidate.finishReason);
					if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}

				if (data.usageMetadata) {
					const cacheRead = data.usageMetadata.cachedContentTokenCount ?? 0;
					output.usage = {
						input: (data.usageMetadata.promptTokenCount ?? 0) - cacheRead,
						output: (data.usageMetadata.candidatesTokenCount ?? 0) + (data.usageMetadata.thoughtsTokenCount ?? 0),
						cacheRead,
						cacheWrite: 0,
						reasoning: data.usageMetadata.thoughtsTokenCount ?? 0,
						totalTokens: data.usageMetadata.totalTokenCount ?? 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					calculateCost(model, output.usage);
				}
			}
		}
	} finally {
		options?.signal?.removeEventListener("abort", abortHandler);
	}

	if (currentBlock) {
		if (currentBlock.type === "text") {
			stream.push({ type: "text_end", contentIndex: blockIndex(), content: currentBlock.text, partial: output });
		} else {
			stream.push({
				type: "thinking_end",
				contentIndex: blockIndex(),
				content: currentBlock.thinking,
				partial: output,
			});
		}
	}

	return hasContent;
}

function resetOutput(output: AssistantMessage): void {
	output.content = [];
	output.usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	output.stopReason = "pending";
	output.rawStopReason = undefined;
	output.errorMessage = undefined;
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
	return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/i.test(errorText);
}

function extractErrorMessage(errorText: string): string {
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string } };
		if (parsed.error?.message) return parsed.error.message;
	} catch {
		// Not JSON; return the raw body.
	}
	return errorText;
}

/**
 * Server-requested retry delay from response headers or the Google error body.
 * Rounds up by one second so the retry lands after the reset instant.
 */
export function extractRetryDelay(errorText: string, response?: Response | Headers): number | undefined {
	const normalizeDelay = (ms: number): number | undefined => (ms > 0 ? Math.ceil(ms + 1000) : undefined);
	const headers = response instanceof Headers ? response : response?.headers;

	if (headers) {
		const retryAfter = headers.get("retry-after");
		if (retryAfter) {
			const seconds = Number(retryAfter);
			const delay = Number.isFinite(seconds)
				? normalizeDelay(seconds * 1000)
				: normalizeDelay(new Date(retryAfter).getTime() - Date.now());
			if (delay !== undefined) return delay;
		}

		const rateLimitReset = headers.get("x-ratelimit-reset");
		if (rateLimitReset) {
			const resetSeconds = Number.parseInt(rateLimitReset, 10);
			const delay = Number.isNaN(resetSeconds) ? undefined : normalizeDelay(resetSeconds * 1000 - Date.now());
			if (delay !== undefined) return delay;
		}

		const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
		if (rateLimitResetAfter) {
			const seconds = Number(rateLimitResetAfter);
			const delay = Number.isFinite(seconds) ? normalizeDelay(seconds * 1000) : undefined;
			if (delay !== undefined) return delay;
		}
	}

	const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (durationMatch) {
		const hours = durationMatch[1] ? Number.parseInt(durationMatch[1], 10) : 0;
		const minutes = durationMatch[2] ? Number.parseInt(durationMatch[2], 10) : 0;
		const seconds = Number.parseFloat(durationMatch[3] ?? "");
		if (!Number.isNaN(seconds)) {
			const delay = normalizeDelay(((hours * 60 + minutes) * 60 + seconds) * 1000);
			if (delay !== undefined) return delay;
		}
	}

	const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
	if (retryInMatch?.[1]) {
		const value = Number.parseFloat(retryInMatch[1]);
		const unit = retryInMatch[2]?.toLowerCase();
		if (!Number.isNaN(value) && value > 0) {
			return normalizeDelay(unit === "ms" ? value : value * 1000);
		}
	}

	const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
	if (retryDelayMatch?.[1]) {
		const value = Number.parseFloat(retryDelayMatch[1]);
		const unit = retryDelayMatch[2]?.toLowerCase();
		if (!Number.isNaN(value) && value > 0) {
			return normalizeDelay(unit === "ms" ? value : value * 1000);
		}
	}

	return undefined;
}
