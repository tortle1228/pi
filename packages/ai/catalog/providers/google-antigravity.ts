import type { ModelCost, ThinkingLevelMap } from "../../src/types.ts";
import { ANTIGRAVITY_ENDPOINT } from "../../src/utils/antigravity.ts";
import { type ChatModel, defineProvider, mergeThinking, withInputLimits } from "../define.ts";

// Antigravity serves Gemini, Claude, and GPT-OSS through one Cloud Code Assist
// endpoint. The account's actual inventory comes from `fetchAvailableModels`
// and is stored on the OAuth credential, so the provider filters this list by
// it; entries here keep working accounts selectable when that call fails.
const IMAGE_INPUT: ChatModel["input"] = ["text", "image"];
const TEXT_INPUT: ChatModel["input"] = ["text"];

const FULL_THINKING_LEVELS: ThinkingLevelMap = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

function tieredThinkingLevels(level: "low" | "medium" | "high"): ThinkingLevelMap {
	return { off: null, minimal: level, low: level, medium: level, high: level, xhigh: null, max: null };
}

const GEMINI_3_1_PRO_COST: ModelCost = {
	input: 2,
	output: 12,
	cacheRead: 0.2,
	cacheWrite: 0,
	tiers: [{ inputTokensAbove: 200_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 }],
};

function antigravityModel(input: {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: ModelCost;
	input?: ChatModel["input"];
	thinkingLevelMap?: ThinkingLevelMap;
}): ChatModel {
	return {
		id: input.id,
		name: input.name,
		api: "google-antigravity",
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_ENDPOINT,
		reasoning: input.reasoning,
		input: input.input ?? IMAGE_INPUT,
		cost: input.cost,
		contextWindow: input.contextWindow,
		maxTokens: input.maxTokens,
		...(input.thinkingLevelMap ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
	};
}

export default defineProvider({
	id: "google-antigravity",
	models: () => [
		antigravityModel({
			id: "claude-opus-4-6-thinking",
			name: "Claude Opus 4.6 Thinking (Antigravity)",
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		}),
		antigravityModel({
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6 (Antigravity)",
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		}),
		antigravityModel({
			id: "claude-opus-5-5-high",
			name: "Claude Opus 5.5 High (Antigravity)",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		}),
		antigravityModel({
			id: "claude-opus-5-5-medium",
			name: "Claude Opus 5.5 Medium (Antigravity)",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		}),
		antigravityModel({
			id: "claude-opus-5-5-low",
			name: "Claude Opus 5.5 Low (Antigravity)",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		}),
		antigravityModel({
			id: "claude-sonnet-5-5-high",
			name: "Claude Sonnet 5.5 High (Antigravity)",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		}),
		antigravityModel({
			id: "claude-sonnet-5-5-medium",
			name: "Claude Sonnet 5.5 Medium (Antigravity)",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		}),
		antigravityModel({
			id: "claude-sonnet-5-5-low",
			name: "Claude Sonnet 5.5 Low (Antigravity)",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		}),
		antigravityModel({
			id: "gemini-4-argon-high",
			name: "Gemini 4 Argon High (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
			thinkingLevelMap: tieredThinkingLevels("high"),
		}),
		antigravityModel({
			id: "gemini-4-argon-medium",
			name: "Gemini 4 Argon Medium (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
			thinkingLevelMap: tieredThinkingLevels("medium"),
		}),
		antigravityModel({
			id: "gemini-4-argon-low",
			name: "Gemini 4 Argon Low (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
			thinkingLevelMap: tieredThinkingLevels("low"),
		}),
		antigravityModel({
			id: "gemini-3.8-flash-high",
			name: "Gemini 3.8 Flash High (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
			thinkingLevelMap: tieredThinkingLevels("high"),
		}),
		antigravityModel({
			id: "gemini-3.8-flash-medium",
			name: "Gemini 3.8 Flash Medium (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
			thinkingLevelMap: tieredThinkingLevels("medium"),
		}),
		antigravityModel({
			id: "gemini-3.8-flash-low",
			name: "Gemini 3.8 Flash Low (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
			thinkingLevelMap: tieredThinkingLevels("low"),
		}),
		antigravityModel({
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
				tiers: [{ inputTokensAbove: 200_000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }],
			},
		}),
		antigravityModel({
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
		}),
		antigravityModel({
			id: "gemini-2.5-flash-thinking",
			name: "Gemini 2.5 Flash Thinking (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
		}),
		antigravityModel({
			id: "gemini-2.5-flash-lite",
			name: "Gemini 2.5 Flash Lite (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
		}),
		antigravityModel({
			id: "gemini-3.8-flash-tiered",
			name: "Gemini 3.8 Flash Tiered (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
			thinkingLevelMap: FULL_THINKING_LEVELS,
		}),
		antigravityModel({
			id: "gemini-3-flash",
			name: "Gemini 3 Flash (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
			thinkingLevelMap: FULL_THINKING_LEVELS,
		}),
		antigravityModel({
			id: "gemini-3.5-flash-lite",
			name: "Gemini 3.5 Flash Lite (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
			thinkingLevelMap: FULL_THINKING_LEVELS,
		}),
		antigravityModel({
			id: "gemini-3.1-flash-lite",
			name: "Gemini 3.1 Flash Lite (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
			thinkingLevelMap: FULL_THINKING_LEVELS,
		}),
		antigravityModel({
			id: "gemini-3.1-pro-high",
			name: "Gemini 3.1 Pro High (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: GEMINI_3_1_PRO_COST,
			thinkingLevelMap: tieredThinkingLevels("high"),
		}),
		antigravityModel({
			id: "gemini-3.1-pro-low",
			name: "Gemini 3.1 Pro Low (Antigravity)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			cost: GEMINI_3_1_PRO_COST,
			thinkingLevelMap: tieredThinkingLevels("low"),
		}),
		antigravityModel({
			id: "gpt-oss-120b-medium",
			name: "GPT-OSS 120B Medium (Antigravity)",
			reasoning: false,
			contextWindow: 114_000,
			maxTokens: 32_768,
			cost: { input: 0.09, output: 0.36, cacheRead: 0, cacheWrite: 0 },
			input: TEXT_INPUT,
		}),
	],
	finalize: (model) => {
		// Cloud Code Assist takes token budgets for Claude, not Anthropic's adaptive effort tiers.
		mergeThinking(model, { xhigh: null, max: null });
		withInputLimits(model, { maxRequestBytes: 20 * 1024 * 1024, images: { maxPerRequest: 3600 } });
	},
});
