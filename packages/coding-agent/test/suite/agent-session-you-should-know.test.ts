// Run the extension in a real agent session with the faux provider and check when the side check runs.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import youShouldKnow from "../../src/extensions/you-should-know/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "./harness.ts";

initTheme("dark");

const echo: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

const isSideRequest = (context: Context) =>
	getMessageText(context.messages.at(-1)).includes(`pi's "You should know" feature`);

describe("You should know in an agent session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function run(options: { enabled: boolean; toolTurns: number; sideAnswer: string }) {
		const harness = await createHarness({
			tools: [echo],
			settings: { youShouldKnow: options.enabled },
			extensionFactories: [youShouldKnow],
		});
		harnesses.push(harness);
		const widgets: string[][] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				setWidget: (_key: string, content: unknown) => {
					widgets.push(
						typeof content === "function"
							? content({} as TUI, theme)
									.render(100)
									.map((line: string) => line.replace(/\u001b\[[0-9;]*m/g, ""))
							: [],
					);
				},
			}),
		});
		const sideRequests: Context[] = [];
		const mainRequests: Context[] = [];
		let mainCalls = 0;
		const respond = (context: Context) => {
			if (isSideRequest(context)) {
				sideRequests.push(context);
				return fauxAssistantMessage(options.sideAnswer);
			}
			mainCalls++;
			mainRequests.push(context);
			return mainCalls <= options.toolTurns
				? fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" })
				: fauxAssistantMessage("done");
		};
		harness.setResponses(Array.from({ length: options.toolTurns + 10 }, () => respond));
		await harness.session.prompt("start");
		return { harness, widgets, sideRequests, mainRequests };
	}

	it("checks after the sixth step and shows the note", async () => {
		const { widgets, sideRequests, mainRequests } = await run({
			enabled: true,
			toolTurns: 6,
			sideAnswer: "learn: Echo results are never cached.\ntag: Heads up\nexplain:\n* detail",
		});
		await vi.waitFor(() => expect(widgets.at(-1)?.join("\n")).toContain("Echo results are never cached."));
		expect(sideRequests).toHaveLength(1);
		// Same prefix as the main request after the sixth step, so the provider can reuse its prompt cache.
		expect(sideRequests[0].messages.slice(0, -1)).toEqual(mainRequests[6].messages);
		expect(widgets.at(-1)?.join("\n")).toContain("Heads up");
	});

	it("clears the note after two prompts, but not on its own commands", async () => {
		const { harness, widgets } = await run({ enabled: true, toolTurns: 6, sideAnswer: "learn: Note one." });
		await vi.waitFor(() => expect(widgets.at(-1)?.join("\n")).toContain("Note one."));
		await harness.session.prompt("/you-should-know explain");
		await harness.session.prompt("first");
		expect(widgets.at(-1)?.join("\n")).toContain("Note one.");
		await harness.session.prompt("second");
		expect(widgets.at(-1)).toEqual([]);
	});

	it("shows nothing when the side agent answers none", async () => {
		const { widgets, sideRequests } = await run({ enabled: true, toolTurns: 6, sideAnswer: "learn: none" });
		await vi.waitFor(() => expect(sideRequests).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(widgets).toEqual([]);
	});

	it("does not check before the sixth step", async () => {
		const { sideRequests } = await run({ enabled: true, toolTurns: 4, sideAnswer: "learn: x" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(sideRequests).toHaveLength(0);
	});

	it("makes no extra request when disabled", async () => {
		const { sideRequests } = await run({ enabled: false, toolTurns: 6, sideAnswer: "learn: x" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(sideRequests).toHaveLength(0);
	});
});
