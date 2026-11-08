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

	// Changing the declared tools invalidates the provider's prompt cache, so Plan mode must leave them alone.
	it("keeps the declared tools unchanged across mode switches", async () => {
		const harness = await create();
		const before = harness.session.getActiveToolNames();

		await harness.session.setMode("plan");
		expect(harness.session.getActiveToolNames()).toEqual(before);

		await harness.session.setMode("build");
		expect(harness.session.getActiveToolNames()).toEqual(before);
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
		const result = getToolResult(harness, "write");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Plan mode: only verified inspection tools are allowed. Do not retry this tool; include the action as a step in the plan instead.",
			},
		]);
		// The model must see the block and get a turn to answer, not have the run end on the error.
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
		});
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

	describe("bash approval", () => {
		const UNKNOWN = "npm run check";

		async function createWithApproval(choices: (string | undefined)[], mode: "tui" | "print" = "tui") {
			const bashExecute = vi.fn();
			const harness = await create(vi.fn(), bashExecute);
			const select = vi.fn(async (_title: string) => choices.shift());
			await harness.session.bindExtensions({ uiContext: createTestUiContext({ select }), mode });
			await harness.session.setMode("plan");
			return { harness, bashExecute, select };
		}

		const callsThenDone = (commands: string[]) => [
			...commands.map((command) =>
				fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("done"),
		];

		it("runs an unknown command only after the user allows it", async () => {
			const { harness, bashExecute, select } = await createWithApproval(["Allow"]);
			harness.setResponses(callsThenDone([UNKNOWN]));

			await harness.session.prompt("check");

			expect(select).toHaveBeenCalledTimes(1);
			expect(bashExecute).toHaveBeenCalledTimes(1);
			expect(bashExecute.mock.calls[0][1]).toMatchObject({ command: UNKNOWN });
		});

		it.each(["Deny", undefined])("does not run the command when the answer is %s", async (choice) => {
			const { harness, bashExecute } = await createWithApproval([choice]);
			harness.setResponses(callsThenDone([UNKNOWN]));

			await harness.session.prompt("check");

			expect(bashExecute).not.toHaveBeenCalled();
			expect(getToolResult(harness, "bash").content).toEqual([
				{ type: "text", text: "Plan mode: the user denied this command. Do not retry it." },
			]);
		});

		it("asks again for a repeated command", async () => {
			const { harness, bashExecute, select } = await createWithApproval(["Allow", "Deny"]);
			harness.setResponses(callsThenDone([UNKNOWN, UNKNOWN]));
			await harness.session.prompt("check");
			expect(select).toHaveBeenCalledTimes(2);
			expect(bashExecute).toHaveBeenCalledTimes(1);
		});

		it("shows control characters as visible text but runs the command as sent", async () => {
			const { harness, bashExecute, select } = await createWithApproval(["Allow"]);
			const command = "rm x \x1b[8mhidden\x1b[0m ‮fdp\nls";
			harness.setResponses(callsThenDone([command]));

			await harness.session.prompt("check");

			expect(select.mock.calls[0][0]).toContain("rm x �[8mhidden�[0m �fdp\nls");
			expect(bashExecute.mock.calls[0][1]).toMatchObject({ command });
		});

		it("does not ask for an inspection command and rewrites git", async () => {
			const { harness, bashExecute, select } = await createWithApproval([]);
			harness.setResponses(callsThenDone(["git status | head -5"]));

			await harness.session.prompt("look");

			expect(select).not.toHaveBeenCalled();
			expect(bashExecute.mock.calls[0][1]).toMatchObject({
				command: "git --no-pager --no-optional-locks -c core.fsmonitor=false status | head -5",
			});
		});

		it("blocks an unknown command without asking outside the interactive UI", async () => {
			const { harness, bashExecute, select } = await createWithApproval([], "print");
			harness.setResponses(callsThenDone([UNKNOWN]));

			await harness.session.prompt("check");

			expect(select).not.toHaveBeenCalled();
			expect(bashExecute).not.toHaveBeenCalled();
		});
	});

	it("runs only tools that declare readOnlyHint and blocks the rest in plan mode", async () => {
		const executes = Object.fromEntries(["docs", "reader", "deploy", "other"].map((name) => [name, vi.fn()]));
		const harness = await createHarness({
			extensionFactories: [
				planModeExtension,
				(pi) => {
					pi.registerTool({ ...tool("docs", executes.docs), annotations: { readOnlyHint: true } });
					pi.registerTool({
						...tool("reader", executes.reader),
						annotations: { readOnlyHint: true },
						reachesTools: () => "all",
					});
					pi.registerTool({ ...tool("deploy", executes.deploy), annotations: { readOnlyHint: false } });
					pi.registerTool(tool("other", executes.other));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.setMode("plan");

		for (const name of Object.keys(executes)) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt(`call ${name}`);
		}

		expect(executes.docs).toHaveBeenCalledTimes(1);
		expect(executes.reader).not.toHaveBeenCalled();
		expect(executes.deploy).not.toHaveBeenCalled();
		expect(executes.other).not.toHaveBeenCalled();
	});

	it("stores the instructions in the plan notice once and keeps every earlier request a prefix of the next", async () => {
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
		for (const messages of seen) expect(count(messages, "Plan Mode (Conversational)")).toBe(1);
		expect(count(seen[1], "Plan mode is now active")).toBe(1);
		expect(count(seen[2], "Plan mode has ended")).toBe(1);
		// The provider caches by prefix, so a request may only append to the previous one.
		expect(seen[1].slice(0, seen[0].length)).toEqual(seen[0]);
		expect(seen[2].slice(0, seen[1].length)).toEqual(seen[1]);
	});

	it("sends the instructions again after compaction removed them", async () => {
		const harness = await createHarness({
			tools: [tool("write"), tool("read"), tool("bash")],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				planModeExtension,
				(pi) =>
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					})),
			],
		});
		harnesses.push(harness);
		const seen: string[][] = [];
		const record = (context: { messages: { role: string; content: unknown }[] }) => {
			seen.push(context.messages.map((message) => JSON.stringify(message.content)));
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([record, record, record]);

		await harness.session.setMode("plan");
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		await harness.session.compact();
		await harness.session.prompt("third");

		const count = (messages: string[], text: string) => messages.filter((message) => message.includes(text)).length;
		expect(count(seen[2], "Plan Mode (Conversational)")).toBe(1);
	});

	it("sends the instructions again when the bash approval they describe changes", async () => {
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
		harness.settingsManager.applyOverrides({ plan: { bashApproval: "allow" } });
		await harness.session.prompt("third");

		const count = (messages: string[], text: string) => messages.filter((message) => message.includes(text)).length;
		expect(count(seen[1], "Plan Mode (Conversational)")).toBe(1);
		expect(count(seen[2], "Plan Mode (Conversational)")).toBe(2);
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
