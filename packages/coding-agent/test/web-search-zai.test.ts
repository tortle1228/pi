// Verify the real MCP client against a local HTTP server, with no external requests or paid tokens.
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { getSearchBackend } from "../src/extensions/web-search/search.ts";
import { callZaiSearch, searchZai } from "../src/extensions/web-search/zai.ts";

interface Request {
	id?: number;
	method: string;
	params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

async function server() {
	const calls: Request[] = [];
	const authorizations: (string | undefined)[] = [];
	let deletes = 0;
	const behavior = {
		toolName: "webSearchPrime",
		schema: { type: "object", properties: { search_query: { type: "string" } }, required: ["search_query"] },
		result: { content: [{ type: "text", text: "Example title\nhttps://example.com\nExample summary" }] } as unknown,
		status: 200,
		hold: "",
		invalidJson: false,
	};
	let reached: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const http = createServer(async (req, res) => {
		authorizations.push(req.headers.authorization);
		if (req.method === "DELETE") {
			deletes++;
			res.writeHead(204).end();
			return;
		}
		let body = "";
		for await (const chunk of req) body += chunk;
		// Trust boundary: this controlled fixture accepts JSON-RPC requests from the client under test.
		const request = JSON.parse(body) as Request;
		calls.push(request);
		if (request.method === behavior.hold) {
			reached?.();
			return;
		}
		if (request.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		if (request.method === "initialize") {
			res.setHeader("mcp-session-id", "test-session");
			reply(res, request.id, {
				protocolVersion: request.params?.protocolVersion,
				serverInfo: { name: "fake-zai", version: "1" },
				capabilities: { tools: {} },
			});
		} else if (request.method === "tools/list") {
			reply(res, request.id, { tools: [{ name: behavior.toolName, inputSchema: behavior.schema }] });
		} else if (request.method === "tools/call") {
			if (behavior.status !== 200) res.writeHead(behavior.status).end("Search rejected");
			else if (behavior.invalidJson) res.writeHead(200, { "content-type": "application/json" }).end("{invalid");
			else reply(res, request.id, behavior.result);
		} else res.writeHead(400).end();
	});
	http.listen(0, "127.0.0.1");
	await once(http, "listening");
	const address = http.address();
	if (!address || typeof address === "string") throw new Error("Fixture server has no port");
	onTestFinished(async () => {
		http.closeAllConnections();
		http.close();
		await once(http, "close");
	});
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		calls,
		authorizations,
		behavior,
		held,
		deletes: () => deletes,
	};
}

function reply(res: ServerResponse, id: number, result: unknown) {
	res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

describe("Z.AI search MCP", () => {
	it("initializes, authenticates, sends the query, preserves sources, and closes the session", async () => {
		const s = await server();
		const result = await callZaiSearch("latest docs", "test-key", s.url);
		expect(result).toEqual({ backend: "zai", text: "Example title\nhttps://example.com\nExample summary" });
		expect(s.calls.map((call) => call.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/list",
			"tools/call",
		]);
		expect(s.calls.at(-1)?.params).toEqual({ name: "webSearchPrime", arguments: { search_query: "latest docs" } });
		expect(s.authorizations.every((auth) => auth === "Bearer test-key")).toBe(true);
		expect(s.deletes()).toBe(1);
	});

	it("accepts the alternate published tool name and structured-only results", async () => {
		const s = await server();
		s.behavior.toolName = "web_search_prime";
		s.behavior.result = { structuredContent: { title: "Docs", url: "https://example.com", summary: "Details" } };
		const result = await callZaiSearch("docs", "key", s.url);
		expect(result.text).toMatch(/https:\/\/example.com/);
		expect(result.text).toMatch(/Details/);
	});

	it("does not call an unexpected tool or an incompatible input schema", async () => {
		const s = await server();
		s.behavior.toolName = "other";
		await expect(callZaiSearch("docs", "key", s.url)).rejects.toThrow(/does not offer/);
		s.behavior.toolName = "webSearchPrime";
		s.behavior.schema.required = ["another_argument"];
		await expect(callZaiSearch("docs", "key", s.url)).rejects.toThrow(/incompatible/);
		expect(s.calls.filter((call) => call.method === "tools/call")).toHaveLength(0);
		expect(s.deletes()).toBe(2);
	});

	for (const status of [401, 429, 500]) {
		it(`reports HTTP ${status} without retrying the search and closes the session`, async () => {
			const s = await server();
			s.behavior.status = status;
			await expect(callZaiSearch("docs", "key", s.url)).rejects.toMatchObject({ status });
			expect(s.calls.filter((call) => call.method === "tools/call")).toHaveLength(1);
			expect(s.deletes()).toBe(1);
		});
	}

	it("reports MCP tool errors, empty results, and malformed responses", async () => {
		const s = await server();
		s.behavior.result = { isError: true, content: [{ type: "text", text: "Quota exceeded" }] };
		await expect(callZaiSearch("docs", "key", s.url)).rejects.toThrow(/Quota exceeded/);
		s.behavior.result = { content: [] };
		await expect(callZaiSearch("docs", "key", s.url)).rejects.toThrow(/no readable content/);
		s.behavior.result = { content: "invalid" };
		await expect(callZaiSearch("docs", "key", s.url)).rejects.toThrow(/Invalid MCP/);
		s.behavior.invalidJson = true;
		await expect(callZaiSearch("docs", "key", s.url)).rejects.toThrow(SyntaxError);
		expect(s.deletes()).toBe(4);
	});

	for (const method of ["initialize", "tools/list", "tools/call"]) {
		it(`cancels during ${method} and releases the connection`, async () => {
			const s = await server();
			s.behavior.hold = method;
			const controller = new AbortController();
			const rejected = expect(callZaiSearch("docs", "key", s.url, controller.signal)).rejects.toMatchObject({
				name: "AbortError",
			});
			await s.held;
			controller.abort();
			await rejected;
			expect(s.deletes()).toBe(method === "initialize" ? 0 : 1);
		});
	}

	it("enforces a 60-second deadline even while initialization is stalled", async () => {
		const s = await server();
		s.behavior.hold = "initialize";
		const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(50));
		onTestFinished(() => timeout.mockRestore());
		await expect(callZaiSearch("docs", "key", s.url)).rejects.toMatchObject({ name: "TimeoutError" });
		expect(timeout).toHaveBeenCalledWith(60_000);
	});

	it("does not open a connection for an already cancelled request", async () => {
		const s = await server();
		await expect(callZaiSearch("docs", "key", s.url, AbortSignal.abort())).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(s.calls).toHaveLength(0);
	});

	it("uses fresh host credentials for every search at the official endpoint", async () => {
		const s = await server();
		const realFetch = globalThis.fetch;
		const requested: string[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
			requested.push(String(input));
			return realFetch(s.url, init);
		});
		onTestFinished(() => fetchSpy.mockRestore());
		let key = "first-key";
		// Only model identity and the host auth method are used by this backend.
		const ctx = {
			model: { provider: "zai", id: "test-model", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: key }) },
		} as unknown as ExtensionContext;
		await searchZai("first", ctx);
		key = "refreshed-key";
		// Through the provider dispatch, which loads this backend lazily.
		await getSearchBackend("zai")?.search("second", ctx);
		expect(s.calls.at(-1)?.params?.arguments).toEqual({ search_query: "second" });
		expect(new Set(requested)).toEqual(new Set(["https://api.z.ai/api/mcp/web_search_prime/mcp"]));
		expect(s.authorizations[0]).toBe("Bearer first-key");
		expect(s.authorizations.at(-1)).toBe("Bearer refreshed-key");
		expect(s.deletes()).toBe(2);
	});
});
