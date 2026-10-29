import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractRetryDelay, stream, streamSimple } from "../src/api/google-antigravity.ts";
import type { Credential } from "../src/auth/types.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { googleAntigravityProvider } from "../src/providers/google-antigravity.ts";
import type { AssistantMessageEvent, Context } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const API_KEY = JSON.stringify({ token: "access-token", projectId: "project-1" });

type CapturedRequest = { url: string; init: RequestInit };

function sseResponse(...chunks: unknown[]): Response {
	const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(body));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function emptyResponse(): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function mockFetch(respond: () => Response): { fetchMock: ReturnType<typeof vi.fn>; captured: CapturedRequest[] } {
	const captured: CapturedRequest[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		captured.push({ url: String(input), init: init ?? {} });
		return respond();
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, captured };
}

function requestContext(): Context {
	return {
		systemPrompt: "You are a test assistant.",
		messages: [{ role: "user", content: "Check status", timestamp: Date.now() }],
		tools: [{ name: "get_status", description: "Get status", parameters: Type.Object({}) }],
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Google Antigravity stream", () => {
	it("sends the Antigravity envelope and streams thinking and text", async () => {
		const { captured } = mockFetch(() =>
			sseResponse(
				{
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ text: "" }, { text: "Considering...", thought: true, thoughtSignature: "c2ln" }],
								},
							},
						],
					},
				},
				{
					response: {
						candidates: [
							{
								content: { role: "model", parts: [{ text: "Hello" }] },
								finishReason: "STOP",
							},
						],
						usageMetadata: {
							promptTokenCount: 10,
							cachedContentTokenCount: 2,
							candidatesTokenCount: 5,
							thoughtsTokenCount: 3,
							totalTokenCount: 20,
						},
						responseId: "response-1",
					},
				},
			),
		);

		const model = getBuiltinModel("google-antigravity", "gemini-3.8-flash-high");
		const result = await stream(model, normalizeContext(requestContext()), {
			apiKey: API_KEY,
			thinking: { enabled: true, level: "HIGH" },
			sessionId: "session-1",
		}).result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("response-1");
		expect(result.content).toMatchObject([
			{ type: "thinking", thinking: "Considering...", thinkingSignature: "c2ln" },
			{ type: "text", text: "Hello" },
		]);
		expect(result.usage).toMatchObject({
			input: 8,
			output: 8,
			cacheRead: 2,
			reasoning: 3,
			totalTokens: 20,
		});

		const request = captured[0]!;
		expect(request.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		const headers = new Headers(request.init.headers);
		expect(headers.get("authorization")).toBe("Bearer access-token");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("accept")).toBe("text/event-stream");
		expect(headers.get("user-agent")).toMatch(/^antigravity\/hub\/2\./);
		expect(headers.has("anthropic-beta")).toBe(false);

		const body = JSON.parse(String(request.init.body));
		expect(body).toMatchObject({
			project: "project-1",
			model: "gemini-3.8-flash-high",
			requestType: "agent",
			userAgent: "antigravity",
		});
		expect(body.requestId).toMatch(/^agent-/);
		expect(body.request.sessionId).toBe("session-1");
		expect(body.request.systemInstruction.role).toBe("user");
		expect(body.request.systemInstruction.parts[0].text).toContain("You are Antigravity");
		expect(body.request.systemInstruction.parts[1].text).toBe("You are a test assistant.");
		expect(body.request.contents[0].parts[0].text).toBe("Check status");
		expect(body.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
		expect(body.request.tools[0].functionDeclarations[0]).toMatchObject({
			name: "get_status",
			description: "Get status",
		});
		expect(body.request.tools[0].functionDeclarations[0]).toHaveProperty("parametersJsonSchema");
	});

	it("defaults missing tool call arguments to an empty object", async () => {
		mockFetch(() =>
			sseResponse({
				response: {
					candidates: [
						{
							content: { role: "model", parts: [{ functionCall: { name: "get_status" } }] },
							finishReason: "STOP",
						},
					],
				},
			}),
		);

		const model = getBuiltinModel("google-antigravity", "gemini-3.8-flash-high");
		const result = await stream(model, normalizeContext(requestContext()), { apiKey: API_KEY }).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "toolCall", name: "get_status", arguments: {} });
	});

	it("retries an empty SSE response without a duplicate start event", async () => {
		let calls = 0;
		const { fetchMock } = mockFetch(() => {
			calls += 1;
			return calls === 1
				? emptyResponse()
				: sseResponse({
						response: {
							candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
						},
					});
		});

		const model = getBuiltinModel("google-antigravity", "gemini-3.8-flash-high");
		const events: AssistantMessageEvent[] = [];
		const s = stream(model, normalizeContext(requestContext()), { apiKey: API_KEY });
		for await (const event of s) events.push(event);
		const result = await s.result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "Hello" }]);
	});

	it("uses OpenAPI parameters and the interleaved thinking header for Claude", async () => {
		const { captured } = mockFetch(() =>
			sseResponse({
				response: {
					candidates: [{ content: { role: "model", parts: [{ text: "Done" }] }, finishReason: "STOP" }],
				},
			}),
		);

		const model = getBuiltinModel("google-antigravity", "claude-opus-4-6-thinking");
		await stream(model, normalizeContext(requestContext()), {
			apiKey: API_KEY,
			thinking: { enabled: true, budgetTokens: 8192 },
		}).result();

		const request = captured[0]!;
		expect(new Headers(request.init.headers).get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
		const body = JSON.parse(String(request.init.body));
		expect(body.request.generationConfig.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 8192,
		});
		expect(body.request.tools[0].functionDeclarations[0]).toHaveProperty("parameters");
		expect(body.request.tools[0].functionDeclarations[0]).not.toHaveProperty("parametersJsonSchema");
	});

	it("retries a retryable HTTP error", async () => {
		let calls = 0;
		const { fetchMock } = mockFetch(() => {
			calls += 1;
			if (calls === 1) {
				return new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "0" },
				});
			}
			return sseResponse({
				response: {
					candidates: [{ content: { role: "model", parts: [{ text: "Recovered" }] }, finishReason: "STOP" }],
				},
			});
		});

		const model = getBuiltinModel("google-antigravity", "gemini-3.8-flash-high");
		const result = await stream(model, normalizeContext(requestContext()), {
			apiKey: API_KEY,
			maxRetries: 1,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "Recovered" }]);
	});

	it("fails fast when the server delay exceeds maxRetryDelayMs", async () => {
		const { fetchMock } = mockFetch(
			() =>
				new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "120" },
				}),
		);

		const model = getBuiltinModel("google-antigravity", "gemini-3.8-flash-high");
		const result = await stream(model, normalizeContext(requestContext()), {
			apiKey: API_KEY,
			maxRetries: 3,
			maxRetryDelayMs: 1000,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Server requested 121s retry delay");
	});

	it("clamps xhigh to the high budget for budget-based models", async () => {
		const { captured } = mockFetch(() =>
			sseResponse({
				response: { candidates: [{ content: { role: "model", parts: [{ text: "Done" }] }, finishReason: "STOP" }] },
			}),
		);

		const model = getBuiltinModel("google-antigravity", "claude-opus-5-5-high");
		await streamSimple(model, normalizeContext(requestContext()), {
			apiKey: API_KEY,
			reasoning: "xhigh",
		}).result();

		const body = JSON.parse(String(captured[0]!.init.body));
		expect(body.request.generationConfig.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 16_384,
		});
	});

	it("reports HTTP errors with the provider message", async () => {
		mockFetch(
			() =>
				new Response(JSON.stringify({ error: { message: "Quota exhausted for this model" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);

		const model = getBuiltinModel("google-antigravity", "gemini-3.8-flash-high");
		const result = await stream(model, normalizeContext(requestContext()), {
			apiKey: API_KEY,
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Antigravity API error (400)");
		expect(result.errorMessage).toContain("Quota exhausted for this model");
	});
});

describe("extractRetryDelay", () => {
	it("parses Retry-After seconds and HTTP dates", () => {
		expect(extractRetryDelay("", new Response("", { headers: { "Retry-After": "5" } }))).toBe(6000);

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const retryAt = new Date(Date.now() + 12_000).toUTCString();
		expect(extractRetryDelay("", new Response("", { headers: { "Retry-After": retryAt } }))).toBe(13_000);
		vi.useRealTimers();
	});

	it("parses quota reset and retryDelay fields from the body", () => {
		expect(extractRetryDelay("Your quota will reset after 39s")).toBe(40_000);
		expect(extractRetryDelay("Please retry in 250ms")).toBe(1250);
		expect(extractRetryDelay('{"retryDelay":"34.074824224s"}')).toBe(35_075);
		expect(extractRetryDelay("no delay here")).toBeUndefined();
	});
});

describe("Google Antigravity model filtering", () => {
	const provider = googleAntigravityProvider();
	const models = provider.getModels();

	function oauthCredential(availableModelIds?: unknown): Credential {
		return { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000, availableModelIds };
	}

	it("does not offer Anthropic's adaptive effort tiers", () => {
		const claude = models.find((model) => model.id === "claude-opus-5-5-high");
		if (!claude) throw new Error("missing claude-opus-5-5-high");
		expect(getSupportedThinkingLevels(claude)).not.toContain("xhigh");
		expect(getSupportedThinkingLevels(claude)).not.toContain("max");
	});

	it("limits models to the credential's inventory", () => {
		expect(provider.filterModels?.(models, oauthCredential(["gemini-3.8-flash-high"]))).toMatchObject([
			{ id: "gemini-3.8-flash-high", provider: "google-antigravity" },
		]);
	});

	it("keeps the catalog when the inventory is missing or unknown", () => {
		expect(provider.filterModels?.(models, oauthCredential())).toHaveLength(models.length);
		expect(provider.filterModels?.(models, oauthCredential(["unknown-model"]))).toHaveLength(models.length);
		expect(provider.filterModels?.(models, undefined)).toHaveLength(models.length);
	});
});
