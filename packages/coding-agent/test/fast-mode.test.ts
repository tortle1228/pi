import { describe, expect, it } from "vitest";
import { resolveFastModeServiceTier } from "../src/core/fast-mode.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("resolveFastModeServiceTier", () => {
	it.each([
		["openai", "gpt-6.1-sol", "off", undefined],
		["openai", "gpt-6.1-sol", "fast", "priority"],
		["openai", "gpt-6.1-sol", "ultrafast", "ultrafast"],
		["openai-codex", "gpt-6-astra", "ultrafast", "priority"],
		["openai-codex", "gpt-6.1-terra", "ultrafast", "priority"],
		["openai", "gpt-5.5", "fast", "priority"],
		["anthropic", "claude-sonnet", "ultrafast", undefined],
		["azure", "gpt-6.1-sol", "fast", undefined],
	] as const)("%s %s %s -> %s", (provider, modelId, mode, expected) => {
		expect(resolveFastModeServiceTier(provider, modelId, mode)).toBe(expected);
	});
});

describe("fastMode setting", () => {
	it("ignores fastMode from project settings", () => {
		const files: Record<string, string | undefined> = { project: JSON.stringify({ fastMode: "ultrafast" }) };
		const settings = SettingsManager.fromStorage({
			withLock: (scope, fn) => {
				const next = fn(files[scope]);
				if (next !== undefined) files[scope] = next;
			},
		});
		expect(settings.getProjectSettings().fastMode).toBe("ultrafast");
		expect(settings.getFastMode()).toBe("off");
	});

	it("defaults to off and can be set", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getFastMode()).toBe("off");
		settings.setFastMode("ultrafast");
		expect(settings.getFastMode()).toBe("ultrafast");
	});
});
