import type { ImageModel, Model } from "../../src/types.ts";
import { defineProvider, mergeCompat, mergeThinking } from "../define.ts";
import {
	enableOpenAiGrammarTools,
	enableOpenAiMidConvoSystemMessages,
	OPENAI_MAX_INPUT_TOKENS,
	OPENAI_TOOL_SEARCH_MODEL_IDS,
	openAiStandardCost,
	supportsOpenAiXhigh,
} from "../families/openai.ts";

// ChatGPT OAuth models. models.dev does not list them; keep a small, explicit
// list without aliases. Only list models the Codex backend accepts for ChatGPT
// accounts: GPT-5.5 and GPT-5.3 Codex Spark are rejected with "not supported
// when using Codex with a ChatGPT account".
// Context windows match the openai provider's 922K input limit.
const MODELS = [
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", contextWindow: OPENAI_MAX_INPUT_TOKENS },
	{ id: "gpt-6.1-terra", name: "GPT-6.1 Terra", contextWindow: OPENAI_MAX_INPUT_TOKENS },
	{ id: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: OPENAI_MAX_INPUT_TOKENS },
	{ id: "gpt-6-sol", name: "GPT-6 Sol", contextWindow: OPENAI_MAX_INPUT_TOKENS },
	{ id: "gpt-6-luna", name: "GPT-6 Luna", contextWindow: OPENAI_MAX_INPUT_TOKENS },
	{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: OPENAI_MAX_INPUT_TOKENS },
	{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: OPENAI_MAX_INPUT_TOKENS },
	{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: OPENAI_MAX_INPUT_TOKENS },
];

// ChatGPT image generation runs through the Codex Responses endpoint's `image_generation` tool. It is
// billed against the plan's usage limits, so the models carry no per-token price.
const IMAGE_MODEL_IDS = ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra"];

// Codex CLI keeps additional_tools behind its own model list.
const ADDITIONAL_TOOLS_MODEL_IDS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
]);

export default defineProvider({
	id: "openai-codex",
	models: () =>
		MODELS.map(
			({ id, name, contextWindow }): Model<"openai-codex-responses"> => ({
				id,
				name,
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				cost: openAiStandardCost(id),
				contextWindow,
				maxTokens: 128000,
			}),
		),
	images: () =>
		MODELS.filter(({ id }) => IMAGE_MODEL_IDS.includes(id)).map(
			({ id, name }): ImageModel<"openai-codex-images"> => ({
				type: "image",
				id,
				name,
				api: "openai-codex-images",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				input: ["text", "image"],
				output: ["image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		),
	finalize: (model) => {
		if (supportsOpenAiXhigh(model.id)) mergeThinking(model, { minimal: "low" });
		enableOpenAiGrammarTools(model);
		if (OPENAI_TOOL_SEARCH_MODEL_IDS.has(model.id)) {
			mergeCompat(model as Model<"openai-codex-responses">, {
				...(ADDITIONAL_TOOLS_MODEL_IDS.has(model.id) ? { supportsAdditionalTools: true } : {}),
				supportsToolSearch: true,
			});
		}
		enableOpenAiMidConvoSystemMessages(model, { proxy: false });
	},
});
