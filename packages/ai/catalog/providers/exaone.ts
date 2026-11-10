import type { Model } from "../../src/types.ts";
import { defineProvider } from "../define.ts";

// models.dev does not list EXAONE. Values from https://docs.exaone.ai/ko/docs/k-exaone-2.5 and
// https://docs.exaone.ai/ko/docs/models. The API is free: https://www.lgresearch.ai/news/view?seq=755
const MODELS: Model<"openai-completions">[] = [
	{
		id: "k-exaone_v2.5",
		name: "K-EXAONE 2.5",
		api: "openai-completions",
		baseUrl: "https://api.exaone.ai/v1",
		provider: "exaone",
		reasoning: true,
		// The model always reasons, and the docs list only low/high/max (unknown values return 400).
		// A request without a reasoning level sends no reasoning_effort, so the server default (max) applies.
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 524288,
		// The API rejects input + max_tokens above the context window; 128K keeps headroom over
		// pi's input token estimate instead of the documented 512K output limit.
		maxTokens: 131072,
		// Recommended by EXAONE for agent use.
		samplingParams: { temperature: 1.0, top_p: 0.95, chat_template_kwargs: { preserve_thinking: true } },
	},
];

export default defineProvider({
	id: "exaone",
	models: () => structuredClone(MODELS),
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			thinkingFormat: "openai",
		},
	},
});
