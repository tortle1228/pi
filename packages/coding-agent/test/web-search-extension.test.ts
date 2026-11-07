// Verify extension registration, provider transitions, and execution-time provider and auth selection.
import type { TSchema } from "typebox";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import webSearch from "../src/extensions/web-search/index.ts";
import { getSearchBackend } from "../src/extensions/web-search/search.ts";
import { searchZai } from "../src/extensions/web-search/zai.ts";

function context(provider?: string): ExtensionToolContext {
	// These tests exercise only model identity and auth; the rest of the host context is unused.
	return {
		model: provider ? { provider, id: "test-model", baseUrl: "https://api.z.ai/api/coding/paas/v4" } : undefined,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
	} as unknown as ExtensionToolContext;
}

function harness(defaultTools?: string[]) {
	let active = ["read", "bash"];
	let registered: ToolDefinition<TSchema, unknown, unknown> | undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const stub = {
		registerTool(tool: ToolDefinition<TSchema, unknown, unknown>) {
			registered = tool;
		},
		getActiveTools: () => active,
		getSettings: () => ({ defaultTools }),
		setActiveTools(names: string[]) {
			active = names;
		},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			handlers.set(event, handler);
		},
	};
	// The fixture implements exactly the host methods this extension uses.
	webSearch(stub as unknown as ExtensionAPI);
	if (!registered) throw new Error("web_search was not registered");
	return {
		tool: registered,
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
	it("registers one inactive standalone tool", () => {
		const h = harness();
		expect(h.tool.name).toBe("web_search");
		expect(h.tool.defaultActive).toBe(false);
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
		h.emit("model_select", context("zai"));
		expect(h.active()).toEqual(["read", "bash", "web_search"]);
		h.emit("model_select", context());
		expect(h.active()).toEqual(["read", "bash"]);
	});

	it("does not activate unsupported providers, including inherited object keys", () => {
		const h = harness();
		for (const provider of [undefined, "anthropic", "zai-coding-cn", "toString", "__proto__"]) {
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
		await expect(
			h.tool.execute("id", { query: "hello" }, undefined, undefined, context("anthropic")),
		).rejects.toThrow();
		expect(h.active()).toEqual(["read", "bash"]);
		h.emit("model_select", context("zai"));
		expect(h.active()).toContain("web_search");
	});

	it("checks the provider at execution rather than using the last activation", async () => {
		const h = harness();
		h.emit("session_start", context("zai"));
		await expect(
			h.tool.execute("id", { query: "hello" }, undefined, undefined, context("anthropic")),
		).rejects.toThrow(/not supported.*anthropic/);
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
});
