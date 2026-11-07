// Exercise the Anthropic Messages transport against an offline SSE server.
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { searchAnthropic } from "../src/extensions/web-search/anthropic.ts";

function sse(events: Array<Record<string, unknown>>): string {
	return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function usage(output = 0) {
	return { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

async function fixture() {
	const requests: { url?: string; body: Record<string, unknown>; apiKey?: string; extra?: string }[] = [];
	const behavior = { status: 200, search: true, errorCode: "", text: "Search answer", hold: false };
	let reached: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		requests.push({
			url: req.url,
			body: JSON.parse(Buffer.concat(chunks).toString()),
			apiKey: req.headers["x-api-key"] as string | undefined,
			extra: req.headers["x-test"] as string | undefined,
		});
		reached();
		if (behavior.hold) return;
		if (behavior.status !== 200) {
			res.writeHead(behavior.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "rejected" } }));
			return;
		}
		const blocks: Array<Record<string, unknown>> = [];
		if (behavior.search) {
			blocks.push({
				type: "content_block_start",
				index: blocks.length,
				content_block: behavior.errorCode
					? {
							type: "web_search_tool_result",
							content: { type: "web_search_tool_result_error", error_code: behavior.errorCode },
						}
					: {
							type: "web_search_tool_result",
							content: [
								{ type: "web_search_result", url: "https://example.com/source", title: "Source" },
								{ type: "web_search_result", url: "https://example.com/cited", title: "Cited" },
							],
						},
			});
			blocks.push({ type: "content_block_stop", index: blocks.length - 1 });
		}
		const textIndex = blocks.length;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(
			sse([
				{ type: "message_start", message: { id: "msg_1", model: "selected-model", usage: usage() } },
				...blocks,
				{
					type: "content_block_start",
					index: textIndex,
					content_block: { type: "text", text: "" },
				},
				{
					type: "content_block_delta",
					index: textIndex,
					delta: { type: "text_delta", text: behavior.text },
				},
				{
					type: "content_block_delta",
					index: textIndex,
					delta: {
						type: "citations_delta",
						citation: { type: "web_search_result_location", url: "https://example.com/cited" },
					},
				},
				{ type: "content_block_stop", index: textIndex },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usage(5) },
				{ type: "message_stop" },
			]),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	onTestFinished(async () => {
		server.closeAllConnections();
		server.close();
		await once(server, "close");
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture server has no port");
	const ctx = {
		model: {
			provider: "anthropic",
			id: "selected-model",
			api: "anthropic-messages",
			baseUrl: `http://127.0.0.1:${address.port}`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-ant-test", headers: { "x-test": "value" } }),
		},
	} as unknown as ExtensionContext;
	return { requests, behavior, ctx, held };
}

describe("Anthropic search", () => {
	it("uses anthropic credentials, the selected model, and preserves sources", async () => {
		const f = await fixture();
		const result = await searchAnthropic("latest docs", f.ctx);
		expect(result).toEqual({
			backend: "anthropic",
			text: "Search answer\n\nSources:\nhttps://example.com/source\nhttps://example.com/cited",
		});
		expect(f.requests).toHaveLength(1);
		const req = f.requests[0];
		expect(req.url).toContain("/v1/messages");
		expect(req.apiKey).toBe("sk-ant-test");
		expect(req.extra).toBe("value");
		expect(req.body.model).toBe("selected-model");
		expect(req.body.tools).toEqual([{ type: "web_search_20260209", name: "web_search" }]);
		expect(req.body.tool_choice).toBeUndefined();
		expect(req.body.thinking).toEqual({ type: "disabled" });
		expect(JSON.stringify(req.body.messages)).toContain("latest docs");
	});

	it("keeps effort low when the model cannot disable thinking", async () => {
		const f = await fixture();
		Object.assign(f.ctx.model!, {
			thinkingLevelMap: { off: null },
			compat: { supportsMidConvoEffort: true },
		});
		await searchAnthropic("q", f.ctx);
		const body = f.requests[0].body;
		expect(body.thinking).not.toEqual({ type: "disabled" });
		const messages = body.messages as { output_config?: { effort?: string } }[];
		expect(messages.at(-1)?.output_config).toEqual({ effort: "low" });
		expect(messages.some((message) => message.output_config?.effort === "high")).toBe(false);
	});

	it("rejects a provider search error, an unsearched result, an empty answer, and HTTP errors without retrying", async () => {
		const f = await fixture();
		f.behavior.errorCode = "unavailable";
		await expect(searchAnthropic("q", f.ctx)).rejects.toThrow(/unavailable/);
		f.behavior.errorCode = "";
		f.behavior.search = false;
		await expect(searchAnthropic("q", f.ctx)).rejects.toThrow(/did not complete a web search/);
		f.behavior.search = true;
		f.behavior.text = "";
		await expect(searchAnthropic("q", f.ctx)).rejects.toThrow(/no readable content/);
		f.behavior.text = "answer";
		f.behavior.status = 400;
		await expect(searchAnthropic("q", f.ctx)).rejects.toThrow();
		expect(f.requests).toHaveLength(4);
	});

	it("enforces the deadline", async () => {
		const f = await fixture();
		f.behavior.hold = true;
		const original = AbortSignal.timeout.bind(AbortSignal);
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => original(50));
		onTestFinished(() => timeout.mockRestore());
		await expect(searchAnthropic("q", f.ctx)).rejects.toMatchObject({ name: "TimeoutError" });
		expect(timeout).toHaveBeenCalledWith(60_000);
	});

	it("cancels an in-flight request", async () => {
		const f = await fixture();
		f.behavior.hold = true;
		const controller = new AbortController();
		const pending = searchAnthropic("q", f.ctx, controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await f.held;
		controller.abort();
		await rejected;
		expect(f.requests).toHaveLength(1);
	});

	it("rejects unsupported providers and missing or cancelled authentication", async () => {
		const f = await fixture();
		await expect(searchAnthropic("q", { ...f.ctx, model: undefined })).rejects.toThrow(/requires the anthropic/);
		f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "auth failed" });
		await expect(searchAnthropic("q", f.ctx)).rejects.toThrow(/auth failed/);
		f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true });
		await expect(searchAnthropic("q", f.ctx)).rejects.toThrow(/No API key/);
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const }));
		f.ctx.modelRegistry.getApiKeyAndHeaders = getApiKeyAndHeaders;
		await expect(searchAnthropic("q", f.ctx, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(f.requests).toHaveLength(0);
	});
});
