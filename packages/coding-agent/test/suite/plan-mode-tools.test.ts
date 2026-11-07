import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import planModeExtension from "../../src/extensions/plan-mode/index.ts";
import type { PlanMenuChoice } from "../../src/extensions/plan-mode/plan-menu.ts";
import requestUserInputExtension from "../../src/extensions/request-user-input/index.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const PLAN_RESPONSE = "Here it is.\n\n<proposed_plan>\n# Plan\n</proposed_plan>";

function tool(name: string, execute = vi.fn()) {
	execute.mockResolvedValue({ content: [{ type: "text", text: `${name} ran` }], details: {} });
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute,
	};
}

describe("built-in plan-mode extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function create(writeExecute = vi.fn(), bashExecute = vi.fn()) {
		const harness = await createHarness({
			tools: [tool("write", writeExecute), tool("read"), tool("bash", bashExecute)],
			extensionFactories: [planModeExtension],
		});
		harnesses.push(harness);
		return harness;
	}

	it("removes mutating tools in plan mode and restores them in build mode", async () => {
		const harness = await create();
		expect(harness.session.getActiveToolNames()).toContain("write");

		await harness.session.setMode("plan");
		expect(harness.session.getActiveToolNames()).not.toContain("write");
		expect(harness.session.getActiveToolNames()).toContain("read");

		await harness.session.setMode("build");
		expect(harness.session.getActiveToolNames()).toContain("write");
	});

	it("blocks a mutating tool the model still calls in plan mode", async () => {
		const writeExecute = vi.fn();
		const harness = await create(writeExecute);
		await harness.session.setMode("plan");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("change it");

		expect(writeExecute).not.toHaveBeenCalled();
	});

	it("blocks mutating bash and allows inspection bash in plan mode", async () => {
		const bashExecute = vi.fn();
		const harness = await create(vi.fn(), bashExecute);
		await harness.session.setMode("plan");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls -la" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("look");

		expect(bashExecute).toHaveBeenCalledTimes(1);
		expect(bashExecute.mock.calls[0][1]).toMatchObject({ command: "ls -la" });
	});

	it("sends the instructions on plan requests only and notes each mode change once", async () => {
		const harness = await create();
		const seen: string[][] = [];
		const record = (context: { messages: { role: string; content: unknown }[] }) => {
			seen.push(context.messages.map((message) => JSON.stringify(message.content)));
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([record, record, record]);

		await harness.session.setMode("plan");
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		await harness.session.setMode("build");
		await harness.session.prompt("third");

		const count = (messages: string[], text: string) => messages.filter((message) => message.includes(text)).length;
		expect(count(seen[0], "Plan Mode (Conversational)")).toBe(1);
		expect(count(seen[1], "Plan Mode (Conversational)")).toBe(1);
		expect(count(seen[2], "Plan Mode (Conversational)")).toBe(0);
		expect(count(seen[1], "Plan mode is now active")).toBe(1);
		expect(count(seen[2], "Plan mode has ended")).toBe(1);
	});

	it("nets out mode toggles that leave the model's mode unchanged", async () => {
		const harness = await create();
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.setMode("plan");
		await harness.session.setMode("build");
		await harness.session.prompt("hello");

		const notices = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "plan-mode-notice");
		expect(notices).toEqual([]);
	});

	it("deactivates tools only plan mode activated when it ends", async () => {
		const harness = await createHarness({
			tools: [tool("write"), tool("read"), tool("bash"), tool("grep")],
			initialActiveToolNames: ["write", "read", "bash"],
			extensionFactories: [planModeExtension],
		});
		harnesses.push(harness);

		await harness.session.setMode("plan");
		expect(harness.session.getActiveToolNames()).toContain("grep");

		await harness.session.setMode("build");
		expect(harness.session.getActiveToolNames()).not.toContain("grep");
		expect(harness.session.getActiveToolNames()).toContain("write");
	});

	it("restores tools suppressed by the retired plan-mode package", async () => {
		const harness = await createHarness({
			tools: [tool("write"), tool("read")],
			initialActiveToolNames: ["read"],
			extensionFactories: [planModeExtension],
		});
		harnesses.push(harness);
		harness.sessionManager.appendCustomEntry("plan-mode", { planning: true, suppressedTools: ["write"] });

		await harness.session.bindExtensions({});

		expect(harness.session.getActiveToolNames()).toContain("write");
	});

	it("leaves plan mode with /plan off and enters it with /plan", async () => {
		const harness = await create();

		await harness.session.prompt("/plan");
		expect(harness.session.getMode()).toBe("plan");

		await harness.session.prompt("/plan off");
		expect(harness.session.getMode()).toBe("build");
	});

	it("restores suppressed tools on the branch after a resume in plan mode", async () => {
		const first = await create();
		await first.session.setMode("plan");

		const resumed = await createHarness({
			tools: [tool("write"), tool("read"), tool("bash")],
			extensionFactories: [planModeExtension],
			sessionManager: first.sessionManager,
		});
		harnesses.push(resumed);
		await resumed.session.bindExtensions({});

		expect(resumed.session.getActiveToolNames()).not.toContain("write");
		await resumed.session.setMode("build");
		expect(resumed.session.getActiveToolNames()).toContain("write");
	});

	describe("menu after a proposed plan", () => {
		async function createWithMenu(choice: PlanMenuChoice, mode: "tui" | "print" = "tui") {
			const harness = await create();
			const custom = vi.fn(async () => choice);
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({ custom: custom as never }),
				mode,
			});
			await harness.session.setMode("plan");
			return { harness, custom };
		}

		const sentTexts = (harness: Harness) =>
			harness.session.messages.flatMap((message) =>
				message.role === "user" && typeof message.content !== "string"
					? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
					: message.role === "user"
						? [message.content]
						: [],
			);

		it("switches to build mode and asks to implement", async () => {
			const { harness } = await createWithMenu("implement");
			harness.setResponses([fauxAssistantMessage(PLAN_RESPONSE), fauxAssistantMessage("implemented")]);

			await harness.session.prompt("plan it");

			await vi.waitFor(() => expect(sentTexts(harness)).toContain("Implement the plan."));
			expect(harness.session.getMode()).toBe("build");
		});

		it("stays in plan mode when the user declines", async () => {
			const { harness, custom } = await createWithMenu("stay");
			harness.setResponses([fauxAssistantMessage(PLAN_RESPONSE)]);

			await harness.session.prompt("plan it");

			await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(1));
			expect(harness.session.getMode()).toBe("plan");
			expect(sentTexts(harness)).toEqual(["plan it"]);
		});

		it("opens a fresh session that receives the plan", async () => {
			const { harness } = await createWithMenu("implement-fresh");
			const sendUserMessage = vi.fn(async () => {});
			const newSession = vi.fn(async (options?: { withSession?: (ctx: never) => Promise<void> }) => {
				await options?.withSession?.({ sendUserMessage } as never);
				return { cancelled: false };
			});
			await harness.session.bindExtensions({ commandContextActions: { newSession } as never });
			harness.setResponses([fauxAssistantMessage(PLAN_RESPONSE)]);

			await harness.session.prompt("plan it");

			await vi.waitFor(() =>
				expect(sendUserMessage).toHaveBeenCalledWith("Implement the following plan:\n\n# Plan"),
			);
		});

		it("shows no menu without a complete plan, or outside the interactive UI", async () => {
			const noPlan = await createWithMenu("stay");
			noPlan.harness.setResponses([fauxAssistantMessage("Still thinking. <proposed_plan> soon")]);
			await noPlan.harness.session.prompt("plan it");
			await noPlan.harness.session.waitForIdle();
			expect(noPlan.custom).not.toHaveBeenCalled();

			const print = await createWithMenu("stay", "print");
			print.harness.setResponses([fauxAssistantMessage(PLAN_RESPONSE)]);
			await print.harness.session.prompt("plan it");
			await print.harness.session.waitForIdle();
			expect(print.custom).not.toHaveBeenCalled();
		});

		it("shows no menu after an aborted run", async () => {
			const { harness, custom } = await createWithMenu("stay");
			harness.session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") void harness.session.abort();
			});
			harness.setResponses([fauxAssistantMessage(PLAN_RESPONSE)]);

			await harness.session.prompt("plan it");
			await harness.session.waitForIdle();

			expect(custom).not.toHaveBeenCalled();
		});

		it("shows no menu in build mode", async () => {
			const { harness, custom } = await createWithMenu("stay");
			await harness.session.setMode("build");
			harness.setResponses([fauxAssistantMessage(PLAN_RESPONSE)]);

			await harness.session.prompt("show the format");
			await harness.session.waitForIdle();

			expect(custom).not.toHaveBeenCalled();
		});
	});

	describe("request_user_input tool", () => {
		it("accepts four options, as the Plan Mode instructions allow, and needs the interactive UI", async () => {
			const harness = await createHarness({ extensionFactories: [requestUserInputExtension] });
			harnesses.push(harness);
			const options = ["a", "b", "c", "d"].map((label) => ({ label, description: `${label} choice` }));
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("request_user_input", {
							questions: [{ id: "q", header: "Q", question: "Which?", options }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("ask");

			const result = getToolResult(harness, "request_user_input");
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([{ type: "text", text: "request_user_input requires the interactive UI" }]);
		});
	});
});
