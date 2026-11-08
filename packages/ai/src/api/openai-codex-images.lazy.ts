import type { ProviderImages } from "../types.ts";

export const openaiCodexImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./openai-codex-images.ts")).generateImages(model, context, options),
});
