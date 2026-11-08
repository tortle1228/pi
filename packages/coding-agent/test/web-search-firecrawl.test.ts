// Firecrawl Search and Scrape requests, without calling the real API.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { extractFirecrawl, searchFirecrawl } from "../src/extensions/web-search/firecrawl.ts";

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

describe("Firecrawl web tools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts search and scrape with the bearer header and renders failures", async () => {
		const calls = stubFetch((url, init) => {
			if (url.endsWith("/search")) {
				return Response.json({
					success: true,
					data: {
						web: [{ url: "https://ex.com/a", title: "A", description: "one" }, { url: "https://ex.com/b" }],
					},
				});
			}
			if (String(init?.body).includes("missing")) {
				return Response.json({ success: false, error: "not found" }, { status: 404 });
			}
			return Response.json({ success: true, data: { markdown: "page", metadata: { title: "A" } } });
		});

		expect((await searchFirecrawl("docs", "fc-secret")).text).toBe("A\nhttps://ex.com/a\none\n\nhttps://ex.com/b");
		expect(await extractFirecrawl(["https://ex.com/a", "https://ex.com/missing"], "ignored", "fc-secret")).toBe(
			"A\nhttps://ex.com/a\npage\n\nFailed: https://ex.com/missing (Firecrawl Scrape request failed (404): not found)",
		);

		expect(calls.map((call) => call.url)).toEqual([
			"https://api.firecrawl.dev/v2/search",
			"https://api.firecrawl.dev/v2/scrape",
			"https://api.firecrawl.dev/v2/scrape",
		]);
		for (const call of calls) {
			expect(call.init?.method).toBe("POST");
			expect(call.init?.redirect).toBe("error");
			expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer fc-secret");
		}
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ query: "docs" });
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ url: "https://ex.com/a", formats: ["markdown"] });
	});

	it("throws when every URL fails so the next backend is tried", async () => {
		stubFetch(() => Response.json({ error: "boom" }, { status: 500 }));
		await expect(extractFirecrawl(["https://ex.com/a"], undefined, "fc-secret")).rejects.toThrow(
			"Firecrawl Scrape request failed (500): boom",
		);
	});

	it("rejects malformed search JSON", async () => {
		stubFetch(() => Response.json({ data: { web: [{ title: "missing url" }] } }));
		await expect(searchFirecrawl("docs", "fc-secret")).rejects.toThrow("Firecrawl returned malformed search JSON.");
	});

	it("redacts the key from a failed response", async () => {
		stubFetch(() => Response.json({ error: "rejected fc-secret" }, { status: 401, statusText: "no" }));
		await expect(searchFirecrawl("docs", "fc-secret")).rejects.toThrow(
			"Firecrawl Search request failed (401): rejected [REDACTED]",
		);
	});

	it("does not call the API when the caller already cancelled", async () => {
		const calls = stubFetch(() => Response.json({}));
		await expect(searchFirecrawl("docs", "fc-secret", AbortSignal.abort())).rejects.toThrow(
			"Firecrawl Search cancelled.",
		);
		expect(calls).toHaveLength(0);
	});

	it("keeps finished pages when one URL passes the deadline", async () => {
		const original = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => original(20));
		stubFetch((_url, init) =>
			String(init?.body).includes("slow")
				? new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
					})
				: Response.json({ data: { markdown: "page", metadata: { title: "A" } } }),
		);
		expect(await extractFirecrawl(["https://ex.com/a", "https://ex.com/slow"], undefined, "fc-secret")).toBe(
			"A\nhttps://ex.com/a\npage\n\nFailed: https://ex.com/slow (timed out)",
		);
	});

	it("fails with a timeout when every URL passes the deadline", async () => {
		const original = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => original(20));
		stubFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
				}),
		);
		await expect(extractFirecrawl(["https://ex.com/a"], undefined, "fc-secret")).rejects.toThrow(
			"Firecrawl Extract timed out after 60 seconds.",
		);
	});
});
