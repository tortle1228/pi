import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { FastModeSetting } from "./settings-schema.ts";

export const FAST_MODES = ["off", "fast", "ultrafast"] as const satisfies readonly FastModeSetting[];

/** Models OpenAI serves on the ultrafast tier; other models fall back to fast ("priority"). */
// Measured: the Codex backend accepts "ultrafast" but serves it at standard speed, so only provider "openai" gets it.
const ULTRAFAST_MODEL_IDS = new Set(["gpt-6-astra", "gpt-6.1-sol"]);

export function resolveFastModeServiceTier(
	provider: string,
	modelId: string,
	mode: FastModeSetting,
): SimpleStreamOptions["serviceTier"] {
	if (mode === "off" || (provider !== "openai" && provider !== "openai-codex")) return undefined;
	return mode === "ultrafast" && provider === "openai" && ULTRAFAST_MODEL_IDS.has(modelId) ? "ultrafast" : "priority";
}
