// Exercise the Antigravity transport against an offline SSE server.
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { searchAntigravity } from "../src/extensions/web-search/antigravity.ts";

interface AntigravityBody {
	project?: string;
	request: { tools?: unknown; toolConfig?: unknown; contents?: unknown };
}

async function fixture(modelId = "gemini-3-flash") {
	const requests: { url?: string; body: AntigravityBody }[] = [];
	const behavior = { grounded: true, text: "Search answer" };
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
		const candidate = {
			content: { role: "model", parts: [{ text: behavior.text }] },
			finishReason: "STOP",
			...(behavior.grounded
				? {
						groundingMetadata: {
							webSearchQueries: ["q"],
							groundingChunks: [
								{ web: { uri: "https://example.com/source" } },
								{ web: { uri: "javascript:x" } },
							],
						},
					}
				: {}),
		};
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ response: { candidates: [candidate], responseId: "r1" } })}\n\n`);
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
			provider: "google-antigravity",
			id: modelId,
			api: "google-antigravity",
			baseUrl: `http://127.0.0.1:${address.port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: JSON.stringify({ token: "tok", projectId: "proj-1" }) }),
		},
	} as unknown as ExtensionContext;
	return { requests, behavior, ctx };
}

describe("Antigravity search", () => {
	it("sends googleSearch only and returns the answer with http sources", async () => {
		const f = await fixture();
		const result = await searchAntigravity("latest docs", f.ctx);
		expect(result).toEqual({
			backend: "google-antigravity",
			text: "Search answer\n\nSources:\nhttps://example.com/source",
		});
		const req = f.requests[0];
		expect(req.url).toContain("/v1internal:streamGenerateContent");
		expect(req.body.project).toBe("proj-1");
		expect(req.body.request.tools).toEqual([{ googleSearch: {} }]);
		expect(req.body.request.toolConfig).toBeUndefined();
		expect(JSON.stringify(req.body.request.contents)).toContain("latest docs");
	});

	it("rejects an ungrounded answer", async () => {
		const f = await fixture();
		f.behavior.grounded = false;
		await expect(searchAntigravity("q", f.ctx)).rejects.toThrow(/did not complete a web search/);
	});

	it("rejects non-Gemini models without a request", async () => {
		const f = await fixture("claude-sonnet-4-6");
		await expect(searchAntigravity("q", f.ctx)).rejects.toThrow(/requires a Gemini model/);
		expect(f.requests).toHaveLength(0);
	});
});
