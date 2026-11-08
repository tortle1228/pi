// Exa Search and Contents requests, without calling the real API.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { extractExa, searchExa } from "../src/extensions/web-search/exa.ts";

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

describe("Exa web tools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts search and contents with the key header and renders failures", async () => {
		const calls = stubFetch((url) => {
			if (url.endsWith("/search")) {
				return Response.json({
					results: [
						{ url: "https://ex.com/a", title: "A", highlights: ["one", "two"] },
						{ url: "https://ex.com/b" },
					],
				});
			}
			return Response.json({
				results: [{ url: "https://ex.com/a", title: "A", text: "page" }],
				statuses: [
					{ id: "https://ex.com/a", status: "success" },
					{ id: "https://ex.com/missing", status: "error", error: { tag: "CRAWL_NOT_FOUND" } },
				],
			});
		});

		expect((await searchExa("docs", "exa-secret")).text).toBe("A\nhttps://ex.com/a\none\n\ntwo\n\nhttps://ex.com/b");
		expect(await extractExa(["https://ex.com/a", "https://ex.com/missing"], undefined, "exa-secret")).toBe(
			"A\nhttps://ex.com/a\npage\n\nFailed: https://ex.com/missing (CRAWL_NOT_FOUND)",
		);
		await extractExa(["https://ex.com/a"], "focus", "exa-secret");

		expect(calls.map((call) => call.url)).toEqual([
			"https://api.exa.ai/search",
			"https://api.exa.ai/contents",
			"https://api.exa.ai/contents",
		]);
		for (const call of calls) {
			expect(call.init?.method).toBe("POST");
			expect(call.init?.redirect).toBe("error");
			expect(new Headers(call.init?.headers).get("x-api-key")).toBe("exa-secret");
		}
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			query: "docs",
			type: "auto",
			contents: { highlights: true },
		});
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
			urls: ["https://ex.com/a", "https://ex.com/missing"],
			text: true,
		});
		expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
			urls: ["https://ex.com/a"],
			highlights: { query: "focus" },
		});
	});

	it("rejects malformed search JSON", async () => {
		stubFetch(() => Response.json({ results: [{ title: "missing url" }] }));
		await expect(searchExa("docs", "exa-secret")).rejects.toThrow("Exa returned malformed search JSON.");
	});

	it("redacts the key from a failed response", async () => {
		stubFetch(() => Response.json({ error: "rejected exa-secret" }, { status: 401, statusText: "no" }));
		await expect(searchExa("docs", "exa-secret")).rejects.toThrow(
			"Exa Search request failed (401): rejected [REDACTED]",
		);
	});

	it("does not call the API when the caller already cancelled", async () => {
		const calls = stubFetch(() => Response.json({}));
		await expect(searchExa("docs", "exa-secret", AbortSignal.abort())).rejects.toThrow("Exa Search cancelled.");
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
		await expect(searchExa("docs", "exa-secret")).rejects.toThrow("Exa Search timed out after 60 seconds.");
		expect(timeout.mock.calls.map((call) => call[0])).toEqual([60_000]);
	});
});
