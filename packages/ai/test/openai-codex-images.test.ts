import { describe, expect, it } from "vitest";
import { generateImages } from "../src/api/openai-codex-images.ts";
import { getBuiltinImageModel, getBuiltinImageModels } from "../src/providers/all.ts";
import type { ImagesContext } from "../src/types.ts";

const model = getBuiltinImageModel("openai-codex", "gpt-6-astra");

function mockToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function sse(...events: Record<string, unknown>[]): Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const imageEvents = [
	{ type: "response.created", response: { id: "resp_1" } },
	{ type: "response.output_item.done", item: { type: "image_generation_call", result: "QUJD" } },
	{ type: "response.completed", response: { id: "resp_1" } },
];

const context: ImagesContext = { input: [{ type: "text", text: "a red circle" }] };

function capture(response: () => Response) {
	const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
	const fetch = async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(url),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		});
		return response();
	};
	return { calls, fetch };
}

describe("openai-codex image catalog", () => {
	it("lists the gpt-6 and later models", () => {
		expect(
			getBuiltinImageModels("openai-codex")
				.map((m) => m.id)
				.sort(),
		).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra"]);
		expect(model.api).toBe("openai-codex-images");
	});
});

describe("openai-codex-images", () => {
	it("sends the image_generation tool and returns the image", async () => {
		const { calls, fetch } = capture(() => sse(...imageEvents));
		const result = await generateImages(model, context, { apiKey: mockToken(), fetch });

		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("resp_1");
		expect(result.output).toEqual([{ type: "image", mimeType: "image/png", data: "QUJD" }]);
		const [call] = calls;
		expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(call.headers.get("chatgpt-account-id")).toBe("acc_test");
		expect(call.headers.get("authorization")).toBe(`Bearer ${mockToken()}`);
		expect(call.body).toMatchObject({
			model: "gpt-6-astra",
			store: false,
			stream: true,
			tools: [{ type: "image_generation", output_format: "png" }],
			tool_choice: { type: "image_generation" },
			input: [{ role: "user", content: [{ type: "input_text", text: "a red circle" }] }],
		});
	});

	it("sends input images and the output options", async () => {
		const { calls, fetch } = capture(() => sse(...imageEvents));
		const result = await generateImages(
			model,
			{
				input: [
					{ type: "text", text: "make it blue" },
					{ type: "image", mimeType: "image/png", data: "REVG" },
				],
			},
			{
				apiKey: mockToken(),
				fetch,
				metadata: { outputFormat: "webp", outputCompression: 40, background: "transparent" },
			},
		);

		expect(result.output).toEqual([{ type: "image", mimeType: "image/webp", data: "QUJD" }]);
		expect(calls[0].body).toMatchObject({
			tools: [
				{ type: "image_generation", output_format: "webp", output_compression: 40, background: "transparent" },
			],
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "make it blue" },
						{ type: "input_image", image_url: "data:image/png;base64,REVG" },
					],
				},
			],
		});
	});

	it("rejects a transparent background with jpeg before sending anything", async () => {
		const { calls, fetch } = capture(() => sse(...imageEvents));
		const result = await generateImages(model, context, {
			apiKey: mockToken(),
			fetch,
			metadata: { outputFormat: "jpeg", background: "transparent" },
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("png or webp");
		expect(calls).toHaveLength(0);
	});

	it("fails without an API key", async () => {
		const result = await generateImages(model, context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("No API key");
	});

	it("explains a usage limit error", async () => {
		const { fetch } = capture(
			() =>
				new Response(JSON.stringify({ error: { code: "usage_limit_reached", plan_type: "pro" } }), {
					status: 429,
				}),
		);
		const result = await generateImages(model, context, { apiKey: mockToken(), fetch });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("usage limit");
	});

	it("errors when the stream carries no image", async () => {
		const { fetch } = capture(() =>
			sse({ type: "response.created", response: { id: "r" } }, { type: "response.completed" }),
		);
		const result = await generateImages(model, context, { apiKey: mockToken(), fetch });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no image");
	});

	it("reports a failed response", async () => {
		const { fetch } = capture(() =>
			sse({ type: "response.failed", response: { error: { message: "content blocked" } } }),
		);
		const result = await generateImages(model, context, { apiKey: mockToken(), fetch });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("content blocked");
	});

	it("reports an abort", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
			init?.signal?.throwIfAborted();
			return sse(...imageEvents);
		};
		const result = await generateImages(model, context, { apiKey: mockToken(), fetch, signal: controller.signal });

		expect(result.stopReason).toBe("aborted");
	});
});
