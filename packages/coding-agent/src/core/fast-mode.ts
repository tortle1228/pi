// Fast mode: the priority service tier for OpenAI and OpenAI Codex models.
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { SettingsManager } from "./settings-manager.ts";

type FastModeModel = Pick<Model<Api>, "api" | "provider" | "id">;

// Other providers reuse these APIs (GitHub Copilot, xAI, gateways) but may reject `service_tier`,
// and the adapters would still bill the priority multiplier, so only OpenAI's own lanes qualify.
const FAST_MODE_LANES: ReadonlyArray<{ provider: string; api: Api }> = [
	{ provider: "openai", api: "openai-responses" },
	{ provider: "openai-codex", api: "openai-codex-responses" },
];

/** Whether this model is served by an OpenAI lane that accepts the priority service tier. */
export function modelSupportsFastMode(model: FastModeModel): boolean {
	return FAST_MODE_LANES.some((lane) => lane.provider === model.provider && lane.api === model.api);
}

/** The service tier requests for this model carry: `"priority"` when fast mode is on for it. */
export function getFastModeServiceTier(
	model: FastModeModel,
	settingsManager: SettingsManager,
): ServiceTier | undefined {
	return modelSupportsFastMode(model) && settingsManager.isModelFastMode(model.provider, model.id)
		? "priority"
		: undefined;
}
