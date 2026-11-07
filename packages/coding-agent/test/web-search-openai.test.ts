// Exercise both real pi transports against an offline SSE server.
import { once } from "node:events";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { searchOpenAI } from "../src/extensions/web-search/openai.ts";

async function fixture(provider: "openai" | "openai-codex") {
	const requests: { body: Record<string, unknown>; authorization?: string; account?: string; extra?: string }[] = [];
	const behavior = {
		status: 200,
		search: true,
		text: "Search answer",
		incomplete: false,
		hold: false,
		streamed: false,
	};
	let reached: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const data = Buffer.concat(chunks);
		const body = req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(data) : data;
		requests.push({
			body: JSON.parse(body.toString()),
			authorization: req.headers.authorization,
			account: req.headers["chatgpt-account-id"] as string | undefined,
			extra: req.headers["x-test"] as string | undefined,
		});
		reached();
		if (behavior.hold) return;
		if (behavior.status !== 200) {
			res.writeHead(behavior.status).end("rejected");
			return;
		}
		const output = [
			...(behavior.search
				? [
						{
							type: "web_search_call",
							id: "ws_1",
							status: "completed",
							action: { type: "search", sources: [{ type: "url", url: "https://example.com/source" }] },
						},
					]
				: []),
			{
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [
					{
						type: "output_text",
						text: behavior.text,
						annotations: [{ type: "url_citation", url: "https://example.com/cited" }],
					},
				],
			},
		];
		const event = {
			type: provider === "openai-codex" ? "response.done" : "response.completed",
			response: {
				id: "resp_1",
				status: behavior.incomplete ? "incomplete" : "completed",
				output,
				...(behavior.incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
			},
		};
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (behavior.streamed) {
			for (const [index, item] of output.entries()) {
				res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`);
			}
			event.response.output = [];
		}
		res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
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
	const token =
		provider === "openai"
			? "sk-test"
			: `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.x`;
	const ctx = {
		model: {
			provider,
			id: "selected-model",
			api: provider === "openai" ? "openai-completions" : "openai-codex-responses",
			baseUrl: `http://127.0.0.1:${address.port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		},
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token, headers: { "x-test": "value" } }) },
	} as unknown as ExtensionContext;
	return { requests, behavior, ctx, token, held };
}

describe("OpenAI search", () => {
	for (const provider of ["openai", "openai-codex"] as const) {
		it(`uses ${provider} credentials, selected model, and preserves terminal sources`, async () => {
			const f = await fixture(provider);
			const result = await searchOpenAI("latest docs", f.ctx);
			expect(result).toEqual({
				backend: provider,
				text: "Search answer\n\nSources:\nhttps://example.com/source\nhttps://example.com/cited",
			});
			expect(f.requests).toHaveLength(1);
			const req = f.requests[0];
			expect(req.authorization).toBe(`Bearer ${f.token}`);
			expect(req.extra).toBe("value");
			if (provider === "openai-codex") expect(req.account).toBe("account");
			expect(req.body.model).toBe("selected-model");
			expect(req.body.tools).toEqual([{ type: "web_search" }]);
			expect(req.body.tool_choice).toBe("required");
			expect(JSON.stringify(req.body.input)).toContain("latest docs");
			expect(req.body.include).toContain("web_search_call.action.sources");
		});
		it(`reads ${provider} streamed items when the terminal event omits output`, async () => {
			const f = await fixture(provider);
			f.behavior.streamed = true;
			const result = await searchOpenAI("q", f.ctx);
			expect(result.text).toMatch(/Search answer/);
			expect(result.text).toMatch(/https:\/\/example.com\/cited/);
		});
		it(`enforces the ${provider} deadline`, async () => {
			const f = await fixture(provider);
			f.behavior.hold = true;
			const original = AbortSignal.timeout.bind(AbortSignal);
			const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => original(50));
			onTestFinished(() => timeout.mockRestore());
			await expect(searchOpenAI("q", f.ctx)).rejects.toMatchObject({ name: "TimeoutError" });
			expect(timeout).toHaveBeenCalledWith(60_000);
		});
		it(`rejects ${provider} errors and unsearched, incomplete, or empty results`, async () => {
			const f = await fixture(provider);
			f.behavior.search = false;
			await expect(searchOpenAI("q", f.ctx)).rejects.toThrow(/did not complete a web search/);
			f.behavior.search = true;
			f.behavior.text = "";
			await expect(searchOpenAI("q", f.ctx)).rejects.toThrow(/no readable content/);
			f.behavior.text = "answer";
			f.behavior.incomplete = true;
			await expect(searchOpenAI("q", f.ctx)).rejects.toThrow(/failed|incomplete/i);
			f.behavior.incomplete = false;
			f.behavior.status = 400;
			await expect(searchOpenAI("q", f.ctx)).rejects.toThrow();
			expect(f.requests).toHaveLength(4);
		});
		it(`cancels ${provider} requests`, async () => {
			const f = await fixture(provider);
			f.behavior.hold = true;
			const controller = new AbortController();
			const pending = searchOpenAI("q", f.ctx, controller.signal);
			const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
			await f.held;
			controller.abort();
			await rejected;
			expect(f.requests).toHaveLength(1);
		});
	}
	it("rejects unsupported providers and missing or cancelled authentication", async () => {
		const f = await fixture("openai");
		await expect(searchOpenAI("q", { ...f.ctx, model: undefined })).rejects.toThrow(/requires/);
		f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "auth failed" });
		await expect(searchOpenAI("q", f.ctx)).rejects.toThrow(/auth failed/);
		f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true });
		await expect(searchOpenAI("q", f.ctx)).rejects.toThrow(/No API key/);
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const }));
		f.ctx.modelRegistry.getApiKeyAndHeaders = getApiKeyAndHeaders;
		await expect(searchOpenAI("q", f.ctx, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(f.requests).toHaveLength(0);
	});
});
