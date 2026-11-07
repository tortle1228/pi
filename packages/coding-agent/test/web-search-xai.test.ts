// Exercise the xAI Responses search against an offline SSE server.
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { searchX, searchXai } from "../src/extensions/web-search/openai.ts";

async function fixture() {
	const requests: { body: Record<string, unknown>; authorization?: string }[] = [];
	const behavior = {
		status: 200,
		search: true,
		call: "web_search_call",
		customTools: [] as string[],
		text: "Search answer",
		cited: "https://example.com/cited",
	};
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), authorization: req.headers.authorization });
		if (behavior.status !== 200) {
			res.writeHead(behavior.status).end("rejected");
			return;
		}
		const customCalls = behavior.customTools.map((name, index) => ({
			type: "custom_tool_call",
			call_id: `call_${index}`,
			id: `ctc_${index}`,
			name,
			input: "{}",
			status: "completed",
		}));
		const output = [
			...customCalls,
			...(behavior.search && customCalls.length === 0
				? [
						{
							type: behavior.call,
							id: "call_1",
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
						annotations: [{ type: "url_citation", url: behavior.cited }],
					},
				],
			},
		];
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const [index, item] of customCalls.entries()) {
			res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: index, item })}\n\n`);
			res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`);
		}
		res.end(
			`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output } })}\n\ndata: [DONE]\n\n`,
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
			provider: "xai",
			id: "grok-test",
			api: "openai-responses",
			baseUrl: `http://127.0.0.1:${address.port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		},
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-test", headers: {} }) },
	} as unknown as ExtensionContext;
	return { requests, behavior, ctx };
}

describe("xAI search", () => {
	it("requests xAI web search and returns sources", async () => {
		const f = await fixture();
		const result = await searchXai("latest docs", f.ctx);
		expect(result).toEqual({
			backend: "xai",
			text: "Search answer\n\nSources:\nhttps://example.com/source\nhttps://example.com/cited",
		});
		const req = f.requests[0];
		expect(req.authorization).toBe("Bearer xai-test");
		expect(req.body.model).toBe("grok-test");
		expect(req.body.tools).toEqual([{ type: "web_search" }]);
		expect(req.body.tool_choice).toBe("required");
		expect(req.body.include).toContain("web_search_call.action.sources");
		expect(JSON.stringify(req.body.input)).toContain("latest docs");
	});

	it("requests x_search without tool_choice and accepts server-side X tool calls", async () => {
		const f = await fixture();
		f.behavior.search = false;
		f.behavior.customTools = ["x_keyword_search"];
		f.behavior.cited = "https://x.com/xai/status/1";
		const result = await searchX("latest posts", f.ctx);
		expect(result.backend).toBe("xai");
		expect(result.text).toContain("https://x.com/xai/status/1");
		const req = f.requests[0];
		expect(req.body.tools).toEqual([{ type: "x_search" }]);
		expect(req.body.tool_choice).toBeUndefined();
		expect(req.body.include ?? []).not.toContain("web_search_call.action.sources");
	});

	it("rejects a missing search call, a foreign tool call, and a non-200 response", async () => {
		const f = await fixture();
		f.behavior.search = false;
		await expect(searchXai("q", f.ctx)).rejects.toThrow(/did not complete a web search/);
		await expect(searchX("q", f.ctx)).rejects.toThrow(/did not complete an X search/);
		f.behavior.customTools = ["weather"];
		await expect(searchX("q", f.ctx)).rejects.toThrow(/not an X search/);
		f.behavior.customTools = [];
		f.behavior.search = true;
		f.behavior.status = 400;
		await expect(searchX("q", f.ctx)).rejects.toThrow();
		expect(f.requests).toHaveLength(4);
	});
});
