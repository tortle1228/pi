// Tavily Search and Extract requests, without calling the real API.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { extractTavily, searchTavily } from "../src/extensions/web-search/tavily.ts";

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			return handler(url, init);
		}),
	);
	onTestFinished(() => {
		vi.unstubAllGlobals();
	});
	return calls;
}

describe("Tavily web tools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts search and extract with the bearer header and renders failures", async () => {
		const calls = stubFetch((url) => {
			if (url.endsWith("/search")) {
				return Response.json({
					results: [
						{ url: "https://ex.com/a", title: "A", content: "one" },
						{ url: "https://ex.com/b", content: "" },
					],
				});
			}
			return Response.json({
				results: [{ url: "https://ex.com/a", raw_content: "page" }],
				failed_results: [{ url: "https://ex.com/missing", error: "fetch failed" }],
			});
		});

		expect((await searchTavily("docs", "tvly-secret")).text).toBe("A\nhttps://ex.com/a\none\n\nhttps://ex.com/b");
		expect(await extractTavily(["https://ex.com/a", "https://ex.com/missing"], "focus", "tvly-secret")).toBe(
			"https://ex.com/a\npage\n\nFailed: https://ex.com/missing (fetch failed)",
		);
		expect(await extractTavily(["https://ex.com/a"], undefined, "tvly-secret")).toContain("page");

		expect(calls.map((call) => call.url)).toEqual([
			"https://api.tavily.com/search",
			"https://api.tavily.com/extract",
			"https://api.tavily.com/extract",
		]);
		for (const call of calls) {
			expect(call.init?.method).toBe("POST");
			expect(call.init?.redirect).toBe("error");
			expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer tvly-secret");
		}
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ query: "docs", search_depth: "basic" });
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
			urls: ["https://ex.com/a", "https://ex.com/missing"],
			query: "focus",
		});
		expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ urls: ["https://ex.com/a"] });
	});

	it("rejects malformed search JSON", async () => {
		stubFetch(() => Response.json({ results: [{ title: "missing url" }] }));
		await expect(searchTavily("docs", "tvly-secret")).rejects.toThrow("Tavily returned malformed search JSON.");
	});

	it("redacts the key from a failed response", async () => {
		stubFetch(() => Response.json({ error: "rejected tvly-secret" }, { status: 401, statusText: "no" }));
		await expect(searchTavily("docs", "tvly-secret")).rejects.toThrow(
			"Tavily Search request failed (401): rejected [REDACTED]",
		);
	});

	it("does not call the API when the caller already cancelled", async () => {
		const calls = stubFetch(() => Response.json({}));
		await expect(searchTavily("docs", "tvly-secret", AbortSignal.abort())).rejects.toThrow(
			"Tavily Search cancelled.",
		);
		expect(calls).toHaveLength(0);
	});

	it("times out a stalled search at 60 seconds", async () => {
		const original = AbortSignal.timeout.bind(AbortSignal);
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => original(20));
		stubFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
				}),
		);
		await expect(searchTavily("docs", "tvly-secret")).rejects.toThrow("Tavily Search timed out after 60 seconds.");
		expect(timeout.mock.calls.map((call) => call[0])).toEqual([60_000]);
	});
});
