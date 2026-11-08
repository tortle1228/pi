// Verify extension registration, provider transitions, and execution-time provider and auth selection.
import type { Provider } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import webSearch from "../src/extensions/web-search/index.ts";
import { getSearchBackend, getXSearchBackend } from "../src/extensions/web-search/search.ts";
import { searchZai } from "../src/extensions/web-search/zai.ts";

const savedKeys: { parallel?: string; tavily?: string; exa?: string; firecrawl?: string } = {};
let authFailure: Error | undefined;

function storedKey(id: string): string | undefined {
	return id === "parallel" || id === "tavily" || id === "exa" || id === "firecrawl" ? savedKeys[id] : undefined;
}

function context(provider?: string): ExtensionToolContext {
	// These tests exercise only model identity and stored search keys; the rest of the host context is unused.
	return {
		model: provider ? { provider, id: "test-model", baseUrl: "https://api.z.ai/api/coding/paas/v4" } : undefined,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true }),
			getProviderAuthStatus: (id: string) => ({ configured: Boolean(storedKey(id)?.trim()) }),
			getProviderAuth: async (id: string) => {
				if (authFailure) throw authFailure;
				const key = storedKey(id)?.trim();
				return key ? { auth: { apiKey: key } } : undefined;
			},
		},
	} as unknown as ExtensionToolContext;
}

function harness(defaultTools?: string[], order?: string[]) {
	let active = ["read", "bash"];
	const registered = new Map<string, ToolDefinition<TSchema, unknown, unknown>>();
	const providers = new Map<string, Provider>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const stub = {
		registerTool(tool: ToolDefinition<TSchema, unknown, unknown>) {
			registered.set(tool.name, tool);
		},
		registerProvider(provider: Provider) {
			providers.set(provider.id, provider);
		},
		getActiveTools: () => active,
		getSettings: () => ({ defaultTools, ...(order ? { webSearch: { order } } : {}) }),
		setActiveTools(names: string[]) {
			active = names;
		},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			handlers.set(event, handler);
		},
	};
	// The fixture implements exactly the host methods this extension uses.
	webSearch(stub as unknown as ExtensionAPI);
	const tool = registered.get("web_search");
	const xSearch = registered.get("x_search");
	const webFetch = registered.get("web_fetch");
	const webResearch = registered.get("web_research");
	if (!tool || !xSearch || !webFetch || !webResearch) throw new Error("search tools were not registered");
	return {
		tool,
		xSearch,
		webFetch,
		webResearch,
		providers,
		active: () => active,
		disable: () => stub.setActiveTools(active.filter((name) => name !== "web_search")),
		emit(event: string, ctx: ExtensionContext) {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`No handler for ${event}`);
			handler({}, ctx);
		},
	};
}

describe("provider-aware web_search", () => {
	const savedParallelEnv = process.env.PARALLEL_API_KEY;
	const savedTavilyEnv = process.env.TAVILY_API_KEY;
	beforeEach(() => {
		delete savedKeys.parallel;
		delete savedKeys.tavily;
		delete savedKeys.exa;
		delete savedKeys.firecrawl;
		authFailure = undefined;
		delete process.env.PARALLEL_API_KEY;
		delete process.env.TAVILY_API_KEY;
	});
	afterEach(() => {
		if (savedParallelEnv === undefined) delete process.env.PARALLEL_API_KEY;
		else process.env.PARALLEL_API_KEY = savedParallelEnv;
		if (savedTavilyEnv === undefined) delete process.env.TAVILY_API_KEY;
		else process.env.TAVILY_API_KEY = savedTavilyEnv;
	});

	it("registers inactive standalone search tools", () => {
		const h = harness();
		expect(h.tool.name).toBe("web_search");
		expect(h.xSearch.name).toBe("x_search");
		expect(h.tool.defaultActive).toBe(false);
		expect(h.xSearch.defaultActive).toBe(false);
		expect(h.active()).toEqual(["read", "bash"]);
	});

	it("activates on Z.AI start and preserves other tools across provider transitions", () => {
		const h = harness();
		h.emit("session_start", context("zai"));
		h.emit("model_select", context("zai"));
		expect(h.active()).toEqual(["read", "bash", "web_search"]);
		h.emit("model_select", context("openai"));
		expect(h.active()).toEqual(["read", "bash", "web_search"]);
		h.emit("model_select", context("openai-codex"));
		expect(h.active()).toEqual(["read", "bash", "web_search"]);
		h.emit("model_select", context("anthropic"));
		expect(h.active()).toEqual(["read", "bash", "web_search"]);
		expect(getSearchBackend("anthropic")).toBeDefined();
		h.emit("model_select", context("zai"));
		expect(h.active()).toEqual(["read", "bash", "web_search"]);
		h.emit("model_select", context());
		expect(h.active()).toEqual(["read", "bash"]);
	});

	it("activates x_search only for xai and drops it when the provider changes", () => {
		const h = harness();
		h.emit("model_select", context("xai"));
		expect(h.active()).toEqual(["read", "bash", "web_search", "x_search"]);
		expect(getSearchBackend("xai")).toBeDefined();
		expect(getXSearchBackend("xai")).toBeDefined();
		h.emit("model_select", context("openai"));
		expect(h.active()).toEqual(["read", "bash", "web_search"]);
		expect(getXSearchBackend("openai")).toBeUndefined();
		h.emit("model_select", context("google"));
		expect(h.active()).toEqual(["read", "bash"]);
	});

	it("keeps x_search off when defaultTools removes it", () => {
		const h = harness(["-x_search"]);
		h.emit("session_start", context("xai"));
		expect(h.active()).toEqual(["read", "bash", "web_search"]);
	});

	it("does not activate unsupported providers, including inherited object keys", () => {
		const h = harness();
		for (const provider of [undefined, "google", "zai-coding-cn", "toString", "__proto__"]) {
			h.emit("session_start", context(provider));
			expect(h.active()).toEqual(["read", "bash"]);
			expect(getSearchBackend(provider)).toBeUndefined();
		}
	});

	it("stays off when defaultTools removes it, and the last modifier wins across settings layers", () => {
		const off = harness(["-web_search"]);
		off.emit("session_start", context("zai"));
		off.emit("model_select", context("openai"));
		expect(off.active()).toEqual(["read", "bash"]);
		const on = harness(["-web_search", "+web_search"]);
		on.emit("session_start", context("zai"));
		expect(on.active()).toContain("web_search");
		const offAgain = harness(["+web_search", "-web_search"]);
		offAgain.emit("session_start", context("zai"));
		expect(offAgain.active()).toEqual(["read", "bash"]);
	});

	it("is registered as a built-in extension alongside claude-memory", () => {
		const names = builtInExtensions.map((extension) => (typeof extension === "function" ? "" : extension.name));
		expect(names).toEqual(expect.arrayContaining(["web-search", "claude-memory"]));
	});

	async function execute(text: string) {
		const backend = getSearchBackend("zai");
		if (!backend) throw new Error("zai backend is missing");
		const search = vi.spyOn(backend, "search").mockResolvedValue({ backend: "zai", text });
		onTestFinished(() => search.mockRestore());
		const result = await harness().tool.execute("id", { query: "q" }, undefined, undefined, context("zai"));
		const block = result.content[0];
		if (block.type !== "text") throw new Error("Expected a text result");
		return block.text;
	}

	it("returns a result within the limit unchanged", async () => {
		const text = "line\n".repeat(100);
		expect(await execute(text)).toBe(text);
	});

	it("truncates long results on a line boundary and says so", async () => {
		const text = await execute(Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join("\n"));
		expect(text).toContain("line 1999");
		expect(text).not.toContain("line 2000");
		expect(text).toMatch(/\[Search results truncated: showing .* of .*\.\]$/);
	});

	it("keeps the start of a single line over the limit instead of returning nothing", async () => {
		const text = await execute("메".repeat(30_000));
		expect(text.startsWith("메메메")).toBe(true);
		expect(Buffer.byteLength(text)).toBeLessThan(DEFAULT_MAX_BYTES + 200);
		expect(text).toMatch(/\[Search results truncated: showing .* of .*\.\]$/);
	});

	it("forwards the context and cancellation through the lazy Z.AI backend", async () => {
		const backend = getSearchBackend("zai");
		if (!backend) throw new Error("zai backend is missing");
		const ctx = context("zai");
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const }));
		ctx.modelRegistry.getApiKeyAndHeaders = getApiKeyAndHeaders;
		await expect(backend.search("hello", ctx, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
		await expect(backend.search("hello", ctx)).rejects.toThrow(/No Z.AI API key/);
		expect(getApiKeyAndHeaders).toHaveBeenCalledWith(ctx.model);
	});

	it("refuses to send the key when the zai provider points at another base URL", async () => {
		const ctx = context("zai");
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "proxy-key" }));
		ctx.modelRegistry.getApiKeyAndHeaders = getApiKeyAndHeaders;
		if (!ctx.model) throw new Error("model is missing");
		ctx.model.baseUrl = "https://proxy.example.com/v1";
		await expect(searchZai("hello", ctx)).rejects.toThrow(/requires the official endpoint.*proxy\.example\.com/);
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("keeps manual disabling until the next model-selection event", async () => {
		const h = harness();
		h.emit("session_start", context("zai"));
		h.disable();
		await expect(h.tool.execute("id", { query: "hello" }, undefined, undefined, context("google"))).rejects.toThrow();
		expect(h.active()).toEqual(["read", "bash"]);
		h.emit("model_select", context("zai"));
		expect(h.active()).toContain("web_search");
	});

	it("checks the provider at execution rather than using the last activation", async () => {
		const h = harness();
		h.emit("session_start", context("zai"));
		await expect(h.tool.execute("id", { query: "hello" }, undefined, undefined, context("google"))).rejects.toThrow(
			/not supported.*google/,
		);
	});

	it("rejects blank queries and missing authentication before network access", async () => {
		const h = harness();
		await expect(h.tool.execute("id", { query: "  " }, undefined, undefined, context("zai"))).rejects.toThrow(
			/must not be blank/,
		);
		await expect(searchZai("hello", context("zai"))).rejects.toThrow(/No Z.AI API key/);
		await expect(searchZai("hello", context("openai"))).rejects.toThrow(/requires the zai provider/);
	});

	it("resolves credentials against the model supplied at execution and reports auth failures", async () => {
		const ctx = context("zai");
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: false as const, error: "credentials unavailable" }));
		ctx.modelRegistry.getApiKeyAndHeaders = getApiKeyAndHeaders;
		await expect(searchZai("hello", ctx)).rejects.toThrow(/credentials unavailable/);
		expect(getApiKeyAndHeaders).toHaveBeenCalledWith(ctx.model);
	});

	it("does not resolve credentials for an already cancelled call", async () => {
		const ctx = context("zai");
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const }));
		ctx.modelRegistry.getApiKeyAndHeaders = getApiKeyAndHeaders;
		await expect(searchZai("hello", ctx, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("passes the query, current context, and cancellation to the backend and returns its sources", async () => {
		const h = harness();
		const ctx = context("zai");
		const controller = new AbortController();
		const backend = getSearchBackend("zai");
		if (!backend) throw new Error("zai backend is missing");
		const search = vi
			.spyOn(backend, "search")
			.mockResolvedValue({ backend: "zai", text: "Release notes: https://example.com/releases" });
		onTestFinished(() => search.mockRestore());
		const result = await h.tool.execute("id", { query: "release notes" }, controller.signal, undefined, ctx);
		expect(search).toHaveBeenCalledWith("release notes", ctx, controller.signal);
		expect(result).toEqual({
			content: [{ type: "text", text: "Release notes: https://example.com/releases" }],
			details: { backend: "zai" },
		});
	});

	it("keeps Parallel tools off without a key, including on an unsupported provider", () => {
		const h = harness();
		h.emit("session_start", context("google"));
		expect(h.active()).toEqual(["read", "bash"]);
		expect(h.webFetch.defaultActive).toBe(false);
		expect(h.webResearch.defaultActive).toBe(false);
	});

	it("uses Parallel for a provider without native search when the key is set", async () => {
		savedKeys.parallel = "pk-test";
		const h = harness();
		h.emit("session_start", context("google"));
		expect(h.active()).toEqual(["read", "bash", "web_search", "web_fetch", "web_research"]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				expect(JSON.parse(String(init?.body))).toEqual({
					objective: "docs",
					search_queries: ["docs"],
					mode: "fast",
				});
				expect(new Headers(init?.headers).get("x-api-key")).toBe("pk-test");
				return Response.json({ results: [{ url: "https://ex.com", title: "Ex", excerpts: ["note"] }] });
			}),
		);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const result = await h.tool.execute("id", { query: "docs" }, undefined, undefined, context("google"));
		expect(result).toEqual({
			content: [{ type: "text", text: "Ex\nhttps://ex.com\nnote" }],
			details: { backend: "parallel" },
		});
	});

	it("retries a failed native search once with Parallel", async () => {
		savedKeys.parallel = "pk-test";
		const backend = getSearchBackend("zai");
		if (!backend) throw new Error("zai backend is missing");
		const search = vi.spyOn(backend, "search").mockRejectedValue(new Error("native down"));
		onTestFinished(() => search.mockRestore());
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ results: [{ url: "https://ex.com", title: "Ex", excerpts: ["note"] }] })),
		);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const result = await harness().tool.execute("id", { query: "docs" }, undefined, undefined, context("zai"));
		expect(search).toHaveBeenCalledOnce();
		expect(result.details).toEqual({ backend: "parallel", fallbackFrom: "zai" });
	});

	it("keeps the native error when Parallel is not configured", async () => {
		const backend = getSearchBackend("zai");
		if (!backend) throw new Error("zai backend is missing");
		const search = vi.spyOn(backend, "search").mockRejectedValue(new Error("native down"));
		onTestFinished(() => search.mockRestore());
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		await expect(
			harness().tool.execute("id", { query: "docs" }, undefined, undefined, context("zai")),
		).rejects.toThrow("native down");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not fall back when the caller cancelled", async () => {
		savedKeys.parallel = "pk-test";
		const backend = getSearchBackend("zai");
		if (!backend) throw new Error("zai backend is missing");
		const search = vi.spyOn(backend, "search").mockRejectedValue(new Error("cancelled"));
		onTestFinished(() => search.mockRestore());
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			harness().tool.execute("id", { query: "docs" }, controller.signal, undefined, context("zai")),
		).rejects.toThrow("cancelled");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports both errors when the Parallel fallback also fails", async () => {
		savedKeys.parallel = "pk-test";
		const backend = getSearchBackend("zai");
		if (!backend) throw new Error("zai backend is missing");
		const search = vi.spyOn(backend, "search").mockRejectedValue(new Error("native down"));
		onTestFinished(() => search.mockRestore());
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: { message: "nope" } }, { status: 500, statusText: "nope" })),
		);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		await expect(
			harness().tool.execute("id", { query: "docs" }, undefined, undefined, context("zai")),
		).rejects.toThrow("native down\nParallel fallback failed: Parallel Search request failed (500): nope");
	});

	it("keeps web_fetch off when defaultTools removes it", () => {
		savedKeys.parallel = "pk-test";
		const h = harness(["-web_fetch"]);
		h.emit("session_start", context("google"));
		expect(h.active()).toEqual(["read", "bash", "web_search", "web_research"]);
	});

	it("rejects a password or non-http URL and sends the parsed URL", async () => {
		savedKeys.parallel = "pk-test";
		const h = harness();
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toEqual({ urls: ["https://ex.com/"] });
			return Response.json({ results: [{ url: "https://ex.com/", title: "Ex", excerpts: ["page"] }] });
		});
		vi.stubGlobal("fetch", fetchMock);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		await expect(
			h.webFetch.execute("id", { urls: ["javascript:alert(1)"] }, undefined, undefined, context("google")),
		).rejects.toThrow("URL must be http or https: javascript:alert(1)");
		await expect(
			h.webFetch.execute("id", { urls: ["https://alice:s3cret@ex.com/a"] }, undefined, undefined, context("google")),
		).rejects.toThrow("URL must not include a username or password.");
		expect(fetchMock).not.toHaveBeenCalled();
		const result = await h.webFetch.execute(
			"id",
			{ urls: ["https://ex.com"] },
			undefined,
			undefined,
			context("google"),
		);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(result.content).toEqual([{ type: "text", text: "Ex\nhttps://ex.com/\npage" }]);
	});

	it("keeps the research Response ID when the answer is truncated", async () => {
		savedKeys.parallel = "pk-test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					id: "resp_keep",
					status: "completed",
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "word ".repeat(20_000), annotations: [] }],
						},
					],
				}),
			),
		);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const result = await harness().webResearch.execute(
			"id",
			{ query: "long" },
			undefined,
			undefined,
			context("google"),
		);
		const block = result.content[0];
		if (!block || block.type !== "text") throw new Error("Expected a text result");
		expect(block.text).toContain("Response ID: resp_keep");
		expect(block.text).toMatch(/\[Search results truncated:/);
	});

	it("tries Tavily after Parallel when both earlier backends fail", async () => {
		savedKeys.parallel = "pk-test";
		savedKeys.tavily = "tvly-test";
		const backend = getSearchBackend("zai");
		if (!backend) throw new Error("zai backend is missing");
		const search = vi.spyOn(backend, "search").mockRejectedValue(new Error("native down"));
		onTestFinished(() => search.mockRestore());
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				urls.push(String(input));
				if (String(input).includes("parallel.ai")) {
					return Response.json({ error: { message: "nope" } }, { status: 500, statusText: "nope" });
				}
				return Response.json({ results: [{ url: "https://ex.com", title: "Ex", content: "note" }] });
			}),
		);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const result = await harness().tool.execute("id", { query: "docs" }, undefined, undefined, context("zai"));
		expect(urls.map((url) => new URL(url).host)).toEqual(["api.parallel.ai", "api.tavily.com"]);
		expect(result.details).toEqual({ backend: "tavily", fallbackFrom: "zai" });
	});

	it("uses Tavily before native when the order says so, and does not call native after success", async () => {
		savedKeys.tavily = "tvly-test";
		const backend = getSearchBackend("zai");
		if (!backend) throw new Error("zai backend is missing");
		const search = vi.spyOn(backend, "search").mockResolvedValue({ backend: "zai", text: "native" });
		onTestFinished(() => search.mockRestore());
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tvly-test");
				return Response.json({ results: [{ url: "https://ex.com", title: "Ex", content: "note" }] });
			}),
		);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const result = await harness(undefined, ["tavily", "native"]).tool.execute(
			"id",
			{ query: "docs" },
			undefined,
			undefined,
			context("zai"),
		);
		expect(search).not.toHaveBeenCalled();
		expect(result.details).toEqual({ backend: "tavily" });
	});

	it("keeps web_search off when the order names only Tavily and the key is unset", () => {
		const h = harness(undefined, ["tavily"]);
		h.emit("session_start", context("zai"));
		expect(h.active()).toEqual(["read", "bash"]);
	});

	it("enables web_fetch but not web_research when only the Tavily key is set", () => {
		savedKeys.tavily = "tvly-test";
		const h = harness();
		h.emit("session_start", context("google"));
		expect(h.active()).toEqual(["read", "bash", "web_search", "web_fetch"]);
	});

	it("enables web_fetch but not web_research when only the Exa key is set, and fetches with Exa", async () => {
		savedKeys.exa = "exa-test";
		const h = harness();
		h.emit("session_start", context("google"));
		expect(h.active()).toEqual(["read", "bash", "web_search", "web_fetch"]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				expect(String(input)).toBe("https://api.exa.ai/contents");
				return Response.json({ results: [{ url: "https://ex.com/", text: "page" }], statuses: [] });
			}),
		);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const result = await h.webFetch.execute(
			"id",
			{ urls: ["https://ex.com/"] },
			undefined,
			undefined,
			context("google"),
		);
		expect(result.details).toEqual({ backend: "exa" });
	});

	it("falls back from Tavily to Firecrawl when the order says so", async () => {
		savedKeys.tavily = "tvly-test";
		savedKeys.firecrawl = "fc-test";
		const hosts: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				hosts.push(new URL(String(input)).host);
				if (hosts.length === 1) return new Response("no", { status: 500 });
				return Response.json({ data: { web: [{ url: "https://ex.com/", title: "A", description: "d" }] } });
			}),
		);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const result = await harness(undefined, ["tavily", "firecrawl"]).tool.execute(
			"id",
			{ query: "docs" },
			undefined,
			undefined,
			context("google"),
		);
		expect(hosts).toEqual(["api.tavily.com", "api.firecrawl.dev"]);
		expect(result.details).toEqual({ backend: "firecrawl", fallbackFrom: "tavily" });
	});

	it("does not try Tavily after a cancelled native search", async () => {
		savedKeys.tavily = "tvly-test";
		const backend = getSearchBackend("zai");
		if (!backend) throw new Error("zai backend is missing");
		const search = vi.spyOn(backend, "search").mockRejectedValue(new Error("cancelled"));
		onTestFinished(() => search.mockRestore());
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			harness().tool.execute("id", { query: "docs" }, controller.signal, undefined, context("zai")),
		).rejects.toThrow("cancelled");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fetches with Tavily when Parallel is not configured, and falls back when Parallel extract fails", async () => {
		savedKeys.tavily = "tvly-test";
		const onlyTavily = harness();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				expect(String(input)).toBe("https://api.tavily.com/extract");
				expect(JSON.parse(String(init?.body))).toEqual({ urls: ["https://ex.com/"], query: "focus" });
				return Response.json({ results: [{ url: "https://ex.com/", raw_content: "page" }], failed_results: [] });
			}),
		);
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
		const fetched = await onlyTavily.webFetch.execute(
			"id",
			{ urls: ["https://ex.com"], objective: "focus" },
			undefined,
			undefined,
			context("google"),
		);
		expect(fetched).toEqual({
			content: [{ type: "text", text: "https://ex.com/\npage" }],
			details: { backend: "tavily" },
		});

		savedKeys.parallel = "pk-test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				if (String(input).includes("parallel.ai")) {
					return Response.json({ error: { message: "nope" } }, { status: 500, statusText: "nope" });
				}
				return Response.json({ results: [{ url: "https://ex.com/", raw_content: "page" }] });
			}),
		);
		const fallback = await harness().webFetch.execute(
			"id",
			{ urls: ["https://ex.com"] },
			undefined,
			undefined,
			context("google"),
		);
		expect(fallback.details).toEqual({ backend: "tavily", fallbackFrom: "parallel" });
	});

	it("ignores environment keys when no credential is stored", () => {
		process.env.PARALLEL_API_KEY = "pk-test";
		process.env.TAVILY_API_KEY = "tvly-test";
		const h = harness();
		h.emit("session_start", context("google"));
		expect(h.active()).toEqual(["read", "bash"]);
	});

	it("activates search tools on the next prompt after a key is stored", () => {
		const h = harness();
		h.emit("session_start", context("google"));
		expect(h.active()).toEqual(["read", "bash"]);
		savedKeys.tavily = "tvly-test";
		h.emit("before_agent_start", context("google"));
		expect(h.active()).toEqual(["read", "bash", "web_search", "web_fetch"]);
	});

	it("resolves a stored key and ignores the environment", async () => {
		process.env.PARALLEL_API_KEY = "from-env";
		const provider = harness().providers.get("parallel");
		const resolve = provider?.auth.apiKey?.resolve;
		if (!resolve) throw new Error("parallel provider was not registered");
		const input = {
			ctx: { env: async (name: string) => process.env[name], fileExists: async () => false },
			signal: AbortSignal.timeout(1000),
		};
		await expect(resolve({ ...input, credential: { type: "api_key", key: "stored" } })).resolves.toEqual({
			auth: { apiKey: "stored" },
			source: "stored credential",
		});
		await expect(resolve({ ...input, credential: undefined })).resolves.toBeUndefined();
		await expect(resolve({ ...input, credential: { type: "api_key" } })).rejects.toThrow(
			"Parallel API key could not be read",
		);
		const check = provider.auth.apiKey?.check;
		if (!check) throw new Error("parallel provider has no auth check");
		await expect(check({ ...input, credential: { type: "api_key", key: "stored" } })).resolves.toEqual({
			type: "api_key",
			source: "stored credential",
		});
		await expect(check({ ...input, credential: undefined })).resolves.toBeUndefined();
	});

	it("keeps a manual disable until the saved login changes", () => {
		savedKeys.parallel = "pk-test";
		const h = harness();
		h.emit("session_start", context("google"));
		expect(h.active()).toContain("web_search");
		h.disable();
		h.emit("before_agent_start", context("google"));
		expect(h.active()).not.toContain("web_search");
		savedKeys.tavily = "tvly-test";
		h.emit("before_agent_start", context("google"));
		expect(h.active()).toContain("web_search");
	});

	it("reports a key read failure instead of asking for login", async () => {
		savedKeys.parallel = "pk-test";
		authFailure = new Error("API key auth failed for provider parallel: key command timed out");
		await expect(
			harness().tool.execute("id", { query: "docs" }, undefined, undefined, context("google")),
		).rejects.toThrow("key command timed out");
		await expect(
			harness().tool.execute("id", { query: "docs" }, undefined, undefined, context("google")),
		).rejects.not.toThrow("/login parallel");
	});
});
