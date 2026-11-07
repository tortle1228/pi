// Run the extension in a real agent session: activation, settings, branch navigation, and the tool call path.
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import webSearch from "../../src/extensions/web-search/index.ts";
import { createHarness, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

describe("web_search in an agent session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function start(options: HarnessOptions = {}) {
		const harness = await createHarness({ extensionFactories: [webSearch], ...options });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}
	const zai: HarnessOptions = { provider: "zai", models: [{ id: "z1" }, { id: "z2" }] };
	const isActive = (harness: Harness) => harness.session.getActiveToolNames().includes("web_search");
	const setActive = (harness: Harness, active: boolean) => {
		const others = harness.session.getActiveToolNames().filter((name) => name !== "web_search");
		harness.session.setActiveToolsByName(active ? [...others, "web_search"] : others);
	};

	it("activates for a supported provider and not for others", async () => {
		expect(isActive(await start(zai))).toBe(true);
		expect(isActive(await start())).toBe(false);
	});

	it("honors defaultTools across session start and model selection", async () => {
		const harness = await start({ ...zai, settings: { defaultTools: ["-web_search"] } });
		expect(isActive(harness)).toBe(false);
		await harness.session.setModel(harness.getModel("z2") as Model<string>);
		expect(isActive(harness)).toBe(false);
	});

	it("reactivates after /tree restores a branch recorded without it", async () => {
		const harness = await start(zai);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		setActive(harness, false);
		await harness.session.prompt("first");
		const branch = harness.sessionManager.getLeafId() as string;
		setActive(harness, true);
		await harness.session.prompt("second");
		await harness.session.navigateTree(branch, { summarize: false });
		expect(isActive(harness)).toBe(true);
	});

	it("deactivates after /tree restores a branch recorded with it on an unsupported provider", async () => {
		const harness = await start();
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		setActive(harness, true);
		await harness.session.prompt("first");
		const branch = harness.sessionManager.getLeafId() as string;
		setActive(harness, false);
		await harness.session.prompt("second");
		await harness.session.navigateTree(branch, { summarize: false });
		expect(isActive(harness)).toBe(false);
	});

	it("reaches the Z.AI backend from a model call, which refuses a non-official base URL", async () => {
		const harness = await start(zai);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "docs" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search");
		const result = getToolResult(harness, "web_search");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("requires the official endpoint");
	});
});
