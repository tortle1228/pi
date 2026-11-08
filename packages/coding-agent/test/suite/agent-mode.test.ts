import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getModeSelection } from "../../src/core/agent-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

const MODELS = [
	{ id: "build-model", name: "Build", reasoning: true },
	{ id: "plan-model", name: "Plan", reasoning: true },
	{ id: "flat-model", name: "No reasoning", reasoning: false },
];

describe("AgentSession Plan and Build modes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function create(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness({ models: MODELS, ...options });
		harnesses.push(harness);
		return harness;
	}

	it("starts in build mode and follows build defaults in plan mode without plan defaults", async () => {
		const harness = await create();
		expect(harness.session.getMode()).toBe("build");

		await harness.session.setMode("plan");

		expect(harness.session.getMode()).toBe("plan");
		expect(harness.session.model?.id).toBe("build-model");
	});

	it("applies plan defaults and returns to the build selection", async () => {
		const harness = await create({
			settings: { plan: { defaultProvider: "faux", defaultModel: "plan-model", defaultThinkingLevel: "high" } },
		});
		harness.session.setThinkingLevel("low");

		await harness.session.setMode("plan");
		expect(harness.session.model?.id).toBe("plan-model");
		expect(harness.session.thinkingLevel).toBe("high");

		await harness.session.setMode("build");
		expect(harness.session.model?.id).toBe("build-model");
		expect(harness.session.thinkingLevel).toBe("low");
	});

	it("keeps a selection per mode for the session without saving a default", async () => {
		const harness = await create();
		await harness.session.setMode("plan");
		await harness.session.setModel(harness.getModel("plan-model")!);
		harness.session.setThinkingLevel("high");

		await harness.session.setMode("build");
		expect(harness.session.model?.id).toBe("build-model");

		await harness.session.setMode("plan");
		expect(harness.session.model?.id).toBe("plan-model");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getPlanDefaults()).toEqual({});
	});

	it("saves Ctrl+S selections to the current mode's defaults only", async () => {
		const harness = await create();
		const buildDefault = harness.settingsManager.getDefaultModel();
		const buildThinking = harness.settingsManager.getDefaultThinkingLevel();

		await harness.session.setMode("plan");
		const planModel = harness.getModel("plan-model")!;
		await harness.session.setModel(planModel, { persist: true });
		harness.session.setThinkingLevel("high", { persist: true });

		expect(harness.settingsManager.getPlanDefaults()).toEqual({
			defaultProvider: planModel.provider,
			defaultModel: "plan-model",
			defaultThinkingLevel: "high",
		});
		expect(harness.settingsManager.getDefaultModel()).toBe(buildDefault);
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe(buildThinking);

		await harness.session.setMode("build");
		await harness.session.setModel(harness.getModel("flat-model")!, { persist: true });
		expect(harness.settingsManager.getDefaultModel()).toBe("flat-model");
		expect(harness.settingsManager.getPlanDefaults().defaultModel).toBe("plan-model");
	});

	it("reports each mode's defaults, with plan values falling back to build values", async () => {
		const harness = await create({ settings: { defaultThinkingLevel: "low" } });
		harness.settingsManager.setDefaultModelAndProvider("faux", "build-model");

		await harness.session.setMode("plan");
		expect(harness.session.getModeDefaults()).toEqual({
			provider: "faux",
			modelId: "build-model",
			thinkingLevel: "low",
		});

		harness.settingsManager.setPlanDefaultThinkingLevel("high");
		expect(harness.session.getModeDefaults().thinkingLevel).toBe("high");
	});

	it("fills a partial plan model default from the build default", async () => {
		const harness = await create({ settings: { plan: { defaultModel: "plan-model" } } });
		harness.settingsManager.setDefaultModelAndProvider("faux", "build-model");

		await harness.session.setMode("plan");

		expect(harness.session.model?.id).toBe("plan-model");
	});

	it("clamps the thinking level to the model the mode switches to", async () => {
		const harness = await create({
			settings: { plan: { defaultProvider: "faux", defaultModel: "flat-model", defaultThinkingLevel: "high" } },
		});

		await harness.session.setMode("plan");

		expect(harness.session.model?.id).toBe("flat-model");
		expect(harness.session.thinkingLevel).toBe("off");
	});

	it("falls back to the current model when the mode's default is not available", async () => {
		const harness = await create({
			settings: { plan: { defaultProvider: "faux", defaultModel: "does-not-exist" } },
		});

		await harness.session.setMode("plan");

		expect(harness.session.getMode()).toBe("plan");
		expect(harness.session.model?.id).toBe("build-model");
	});

	it("emits mode_select to extensions and mode_changed to subscribers once per switch", async () => {
		const selected: string[] = [];
		const harness = await create({
			extensionFactories: [
				(pi) => {
					pi.on("mode_select", async (event) => {
						selected.push(`${event.previousMode}->${event.mode}:${pi.getMode()}`);
					});
				},
			],
		});

		await harness.session.setMode("plan");
		await harness.session.setMode("plan");

		expect(selected).toEqual(["build->plan:plan"]);
		expect(harness.eventsOfType("mode_changed").map((event) => event.mode)).toEqual(["plan"]);
	});

	it("restores the mode and its model when a session resumes", async () => {
		const first = await create();
		first.setResponses([fauxAssistantMessage("ok")]);
		await first.session.setMode("plan");
		await first.session.setModel(first.getModel("plan-model")!);
		await first.session.prompt("hello");

		const resumed = await create({
			sessionManager: first.sessionManager,
		});

		expect(resumed.session.getMode()).toBe("plan");
		const branch = resumed.sessionManager.getBranch();
		expect(getModeSelection(branch, "plan").model?.modelId).toBe("plan-model");
		expect(getModeSelection(branch, "build").model?.modelId).toBe("build-model");
	});

	it("leaves plan mode on bind when no extension enforces it", async () => {
		const harness = await create();
		await harness.session.setMode("plan");

		await harness.session.bindExtensions({});

		expect(harness.session.getMode()).toBe("build");
	});

	it("restores the branch's mode and model on tree navigation", async () => {
		const harness = await create();
		// New sessions record their initial model; the harness builds AgentSession without the SDK that does this.
		harness.sessionManager.appendModelChange(harness.getModel("build-model")!.provider, "build-model");
		harness.setResponses([fauxAssistantMessage("build answer"), fauxAssistantMessage("plan answer")]);
		await harness.session.prompt("in build");
		const buildLeaf = harness.sessionManager.getLeafId()!;

		await harness.session.setMode("plan");
		await harness.session.setModel(harness.getModel("plan-model")!);
		await harness.session.prompt("in plan");
		const planLeaf = harness.sessionManager.getLeafId()!;

		await harness.session.navigateTree(buildLeaf);
		expect(harness.session.getMode()).toBe("build");
		expect(harness.session.model?.id).toBe("build-model");

		await harness.session.navigateTree(planLeaf);
		expect(harness.session.getMode()).toBe("plan");
		expect(harness.session.model?.id).toBe("plan-model");
	});

	it("does not send mode entries to the model", async () => {
		const harness = await create();
		await harness.session.setMode("plan");
		await harness.session.setMode("build");

		expect(harness.sessionManager.buildSessionContext().messages).toEqual([]);
	});

	describe("profiles", () => {
		it("snapshots both modes", async () => {
			const harness = await create();
			harness.session.setThinkingLevel("low");
			await harness.session.setMode("plan");
			await harness.session.setModel(harness.getModel("plan-model")!);
			harness.session.setThinkingLevel("high");

			const snapshot = harness.session.getProfileSnapshot();

			expect(snapshot.plan).toEqual({ provider: "faux", model: "plan-model", thinkingLevel: "high" });
			expect(snapshot.build).toMatchObject({ provider: "faux", model: "build-model", thinkingLevel: "low" });
		});

		it("applies to defaults and both modes, overriding what the branch recorded", async () => {
			const harness = await create();
			await harness.session.setMode("plan");
			await harness.session.setModel(harness.getModel("plan-model")!);
			await harness.session.setMode("build");

			await harness.session.applyProfile({
				build: { provider: "faux", model: "flat-model", thinkingLevel: "off" },
				plan: { provider: "faux", model: "build-model", thinkingLevel: "high" },
			});

			expect(harness.session.model?.id).toBe("flat-model");
			expect(harness.settingsManager.getDefaultModel()).toBe("flat-model");
			expect(harness.settingsManager.getPlanDefaults()).toMatchObject({
				defaultModel: "build-model",
				defaultThinkingLevel: "high",
			});
			await harness.session.setMode("plan");
			expect(harness.session.model?.id).toBe("build-model");
			expect(harness.session.thinkingLevel).toBe("high");
			await harness.session.setMode("build");
			expect(harness.session.model?.id).toBe("flat-model");
		});

		it("changes nothing when a model is unknown", async () => {
			const harness = await create();
			await expect(
				harness.session.applyProfile({
					build: { provider: "faux", model: "flat-model", thinkingLevel: "off" },
					plan: { provider: "faux", model: "missing", thinkingLevel: "off" },
				}),
			).rejects.toThrow("Unknown model");
			expect(harness.session.model?.id).toBe("build-model");
			expect(harness.settingsManager.getPlanDefaults()).toEqual({});
		});

		it("uses the current thinking level for a mode never visited when no default is set", async () => {
			const harness = await create();
			harness.session.setThinkingLevel("medium");

			expect(harness.session.getProfileSnapshot().plan.thinkingLevel).toBe("medium");
		});

		it("records one thinking change for the current mode and keeps the profile after tree navigation", async () => {
			const harness = await create();
			harness.sessionManager.appendModelChange("faux", "build-model");
			harness.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
			await harness.session.prompt("first");
			const before = harness.sessionManager.getLeafId()!;
			const thinkingEntries = () =>
				harness.sessionManager.getEntries().filter((entry) => entry.type === "thinking_level_change").length;
			const count = thinkingEntries();

			await harness.session.applyProfile({
				build: { provider: "faux", model: "flat-model", thinkingLevel: "off" },
				plan: { provider: "faux", model: "plan-model", thinkingLevel: "high" },
			});
			// One entry for the other mode; the current mode's flat model clamps to its existing level or adds one.
			expect(thinkingEntries() - count).toBeLessThanOrEqual(2);
			await harness.session.prompt("second");
			const after = harness.sessionManager.getLeafId()!;

			await harness.session.navigateTree(before);
			await harness.session.navigateTree(after);
			await harness.session.setMode("plan");

			expect(harness.session.model?.id).toBe("plan-model");
			expect(harness.session.thinkingLevel).toBe("high");
		});

		it("saves, lists, and deletes profiles in settings", async () => {
			const harness = await create();
			const profile = harness.session.getProfileSnapshot();

			harness.settingsManager.saveProfile("a", profile);
			harness.settingsManager.saveProfile("b", profile);
			harness.settingsManager.deleteProfile("a");

			expect(Object.keys(harness.settingsManager.getProfiles())).toEqual(["b"]);
		});
	});
});
