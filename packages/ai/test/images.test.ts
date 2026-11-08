import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getImageModel } from "../src/image-models.ts";
import { generateImages } from "../src/images.ts";
import type { ImageContent, ImageModel, ImagesContext, ProviderImagesOptions } from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ImagesOptionsWithExtras = ProviderImagesOptions & Record<string, unknown>;

async function basicImageGeneration<TApi extends string>(model: ImageModel<TApi>, options?: ImagesOptionsWithExtras) {
	const context: ImagesContext = {
		input: [{ type: "text", text: "Generate a simple red circle on a plain white background. No text." }],
	};

	const response = await generateImages(model, context, options);

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(response.errorMessage).toBeFalsy();
	expect(response.output.some((item) => item.type === "image")).toBe(true);
	expect(response.timestamp).toBeGreaterThan(0);
}

async function handleImageInput<TApi extends string>(model: ImageModel<TApi>, options?: ImagesOptionsWithExtras) {
	if (!model.input.includes("image")) {
		console.log(`Skipping image input test - model ${model.id} doesn't support image input`);
		return;
	}

	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const imageContent: ImageContent = {
		type: "image",
		data: imageBuffer.toString("base64"),
		mimeType: "image/png",
	};

	const context: ImagesContext = {
		input: [{ type: "text", text: "Create a variation of this image with a blue background." }, imageContent],
	};

	const response = await generateImages(model, context, options);

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(response.output.some((item) => item.type === "image")).toBe(true);
}

const openaiCodexKey = await resolveApiKey("openai-codex");

describe("Images E2E Tests", () => {
	describe.skipIf(!process.env.OPENROUTER_API_KEY)(
		"OpenRouter Images Provider (google/gemini-2.5-flash-image)",
		() => {
			const model = getImageModel("openrouter", "google/gemini-2.5-flash-image");

			it("should generate a basic image", { retry: 3 }, async () => {
				await basicImageGeneration(model);
			});

			it("should handle image input", { retry: 3 }, async () => {
				await handleImageInput(model);
			});
		},
	);

	describe.skipIf(!openaiCodexKey)("OpenAI Codex Images Provider (ChatGPT login)", () => {
		const astra = getImageModel("openai-codex", "gpt-6-astra");
		const options = (metadata?: ImagesOptionsWithExtras["metadata"]) => ({ apiKey: openaiCodexKey, metadata });

		it("should generate a basic image", { retry: 2 }, async () => {
			await basicImageGeneration(astra, options());
		});

		it("should edit an input image", { retry: 2 }, async () => {
			await handleImageInput(astra, options());
		});

		it("should return a png with an alpha channel for a transparent background", { retry: 2 }, async () => {
			const response = await generateImages(
				astra,
				{ input: [{ type: "text", text: "A red circle with no background, nothing else." }] },
				options({ outputFormat: "png", background: "transparent" }),
			);
			expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
			const image = response.output.find((item) => item.type === "image");
			const png = Buffer.from(image?.type === "image" ? image.data : "", "base64");
			expect(png.subarray(1, 4).toString()).toBe("PNG");
			// PNG color type 4 (gray+alpha) or 6 (RGBA).
			expect([4, 6]).toContain(png[25]);
		});

		it("should return a jpeg when asked", { retry: 2 }, async () => {
			const response = await generateImages(
				astra,
				{ input: [{ type: "text", text: "Generate a simple red circle on a plain white background. No text." }] },
				options({ outputFormat: "jpeg", outputCompression: 60 }),
			);
			expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
			const image = response.output.find((item) => item.type === "image");
			expect(image?.type === "image" ? image.mimeType : "").toBe("image/jpeg");
			const jpeg = Buffer.from(image?.type === "image" ? image.data : "", "base64");
			expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
		});

		it("should generate with gpt-6.1-sol", { retry: 2 }, async () => {
			await basicImageGeneration(getImageModel("openai-codex", "gpt-6.1-sol"), options());
		});
	});
});
