// Parallel Search, Extract, and Responses requests, without calling the real API.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { extractParallel, researchParallel, searchParallel } from "../src/extensions/web-search/parallel.ts";

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

describe("Parallel web tools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts search, extract, and research with the x-api-key header", async () => {
		const calls = stubFetch((url) => {
			if (url.endsWith("/v1/search")) {
				return Response.json({
					results: [
						{ url: "https://ex.com/a", title: "A", excerpts: ["one", "two"] },
						{ url: "https://ex.com/b", excerpts: ["three"] },
					],
				});
			}
			if (url.endsWith("/v1/extract")) {
				return Response.json({
					results: [{ url: "https://ex.com/a", title: "A", excerpts: ["page"] }],
					errors: [
						{ url: "https://ex.com/missing", error_type: "fetch_error", http_status_code: 404, content: null },
					],
				});
			}
			return Response.json({
				id: "resp_1",
				status: "completed",
				output: [
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: "Answer",
								annotations: [{ type: "url_citation", url: "https://ex.com/a" }],
							},
						],
					},
				],
			});
		});

		expect((await searchParallel("docs", "secret-key")).text).toBe(
			"A\nhttps://ex.com/a\none\ntwo\n\nhttps://ex.com/b\nhttps://ex.com/b\nthree",
		);
		expect(await extractParallel(["https://ex.com/a", "https://ex.com/missing"], "focus", "secret-key")).toBe(
			"A\nhttps://ex.com/a\npage\n\nFailed: https://ex.com/missing (fetch_error 404)",
		);
		expect(await extractParallel(["https://ex.com/a"], undefined, "secret-key")).toContain("page");
		expect(await researchParallel("What changed?", "low", "resp_0", "secret-key")).toBe(
			"Answer\n\nSources:\nhttps://ex.com/a\n\nResponse ID: resp_1",
		);
		expect(await researchParallel("What changed?", "medium", undefined, "secret-key")).toContain(
			"Response ID: resp_1",
		);

		expect(calls.map((call) => call.url)).toEqual([
			"https://api.parallel.ai/v1/search",
			"https://api.parallel.ai/v1/extract",
			"https://api.parallel.ai/v1/extract",
			"https://api.parallel.ai/v1/responses",
			"https://api.parallel.ai/v1/responses",
		]);
		for (const call of calls) {
			expect(call.init?.method).toBe("POST");
			expect(call.init?.redirect).toBe("error");
			expect(new Headers(call.init?.headers).get("x-api-key")).toBe("secret-key");
		}
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			objective: "docs",
			search_queries: ["docs"],
			mode: "fast",
		});
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
			urls: ["https://ex.com/a", "https://ex.com/missing"],
			objective: "focus",
		});
		expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ urls: ["https://ex.com/a"] });
		expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({
			model: "parallel",
			input: "What changed?",
			reasoning: { effort: "low" },
			stream: false,
			previous_response_id: "resp_0",
		});
		expect(JSON.parse(String(calls[4]?.init?.body))).toEqual({
			model: "parallel",
			input: "What changed?",
			reasoning: { effort: "medium" },
			stream: false,
		});
	});

	it("reports a research validation error and a failed or incomplete response", async () => {
		let n = 0;
		stubFetch(() => {
			n += 1;
			if (n === 1) {
				return Response.json(
					{ detail: [{ loc: ["body", "input"], msg: "input too long", type: "string_too_long" }] },
					{ status: 422, statusText: "Unprocessable Entity" },
				);
			}
			if (n === 2) {
				return Response.json({
					status: "failed",
					error: { code: "server_error", message: "upstream timeout" },
					output: [],
				});
			}
			return Response.json({
				id: "resp_1",
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output: [{ type: "message", content: [{ type: "output_text", text: "Partial", annotations: [] }] }],
			});
		});
		await expect(researchParallel("q", "low", undefined, "secret-key")).rejects.toThrow(
			"Parallel Research request failed (422): input too long",
		);
		await expect(researchParallel("q", "low", undefined, "secret-key")).rejects.toThrow("upstream timeout");
		expect(await researchParallel("q", "low", undefined, "secret-key")).toBe(
			"Partial\n\nResponse ID: resp_1\n\nIncomplete: max_output_tokens",
		);
	});

	it("redacts the key from a failed response", async () => {
		stubFetch(() => Response.json({ error: { message: "rejected secret-key" } }, { status: 401, statusText: "no" }));
		await expect(searchParallel("docs", "secret-key")).rejects.toThrow(
			"Parallel Search request failed (401): rejected [REDACTED]",
		);
	});

	it("does not call the API when the caller already cancelled", async () => {
		const calls = stubFetch(() => Response.json({}));
		await expect(searchParallel("docs", "secret-key", AbortSignal.abort())).rejects.toThrow(
			"Parallel Search cancelled.",
		);
		expect(calls).toHaveLength(0);
	});

	it("times out a stalled search at 60 seconds and research at 120 seconds", async () => {
		const original = AbortSignal.timeout.bind(AbortSignal);
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => original(20));
		stubFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
				}),
		);
		await expect(searchParallel("docs", "secret-key")).rejects.toThrow("Parallel Search timed out after 60 seconds.");
		await expect(researchParallel("docs", "high", undefined, "secret-key")).rejects.toThrow(
			"Parallel Research timed out after 120 seconds.",
		);
		expect(timeout.mock.calls.map((call) => call[0])).toEqual([60_000, 120_000]);
	});
});
