import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createJobsExtension } from "../../src/extensions/jobs/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

/** Operations whose single run exits when the test calls `exit`. */
function controlledOperations(): { operations: BashOperations; exit: (code: number) => void } {
	let finish: ((code: number) => void) | undefined;
	const operations: BashOperations = {
		exec: () =>
			new Promise((resolve) => {
				finish = (exitCode) => resolve({ exitCode });
			}),
	};
	return { operations, exit: (code) => finish?.(code) };
}

function resultTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "job")
		.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
}

describe("AgentSession job tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: Partial<HarnessOptions> = {}) {
		const harness = await createHarness({ extensionFactories: [createJobsExtension()], ...options });
		harnesses.push(harness);
		return harness;
	}

	it("registers job inactive", async () => {
		const harness = await setup();
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("job");
		expect(harness.session.getActiveToolNames()).not.toContain("job");
	});

	it("runs a command in the background and reads its output once it ends", async () => {
		const harness = await setup({ initialActiveToolNames: ["job"] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("job", { action: "start", command: "printf 'hello\\n'; exit 3" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("job", { action: "output", id: "job-1", wait: 30 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("job", { action: "list" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const [started, output, list] = resultTexts(harness);
		expect(started).toBe(
			`Started job-1: printf 'hello\\n'; exit 3\nRead its output with action "output" and id "job-1".`,
		);
		expect(output).toMatch(/^job-1 exited with code 3 after [\d.]+s\nhello\n$/);
		expect(list).toMatch(/^job-1 exited with code 3 after [\d.]+s: printf 'hello\\n'; exit 3$/);
	});

	it("stops running jobs when the session shuts down", async () => {
		const signals: AbortSignal[] = [];
		// Never exits on its own; only the shutdown can end it.
		const operations: BashOperations = {
			exec: (_command, _cwd, { signal }) =>
				new Promise((_resolve, reject) => {
					if (signal) signals.push(signal);
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		};
		const harness = await setup({
			initialActiveToolNames: ["job"],
			extensionFactories: [createJobsExtension({ operations })],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("job", { action: "start", command: "npm run dev" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("started"),
		]);
		await harness.session.prompt("go");
		expect(signals).toHaveLength(1);
		expect(signals[0].aborted).toBe(false);

		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });

		expect(signals[0].aborted).toBe(true);
	});

	it("reports a job that ends while the session is idle without starting a turn", async () => {
		const { operations, exit } = controlledOperations();
		const harness = await setup({
			initialActiveToolNames: ["job"],
			extensionFactories: [createJobsExtension({ operations })],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("job", { action: "start", command: "npm test" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("started"),
		]);
		await harness.session.prompt("go");

		const reported = new Promise<CustomMessage>((resolve) =>
			harness.session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "custom") resolve(event.message);
			}),
		);
		exit(1);
		const message = await reported;

		expect(message.customType).toBe("job-ended");
		expect(message.content).toMatch(
			/^Background job-1 exited with code 1 after [\d.]+s: npm test\nRead its output with the job tool, action "output" and id "job-1"\.$/,
		);
		expect(harness.session.messages.at(-1)).toEqual(message);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("steers the report into a running turn and never triggers one", async () => {
		const { operations, exit } = controlledOperations();
		let tool: ToolDefinition | undefined;
		let sent: (options: unknown) => void = () => {};
		const sentOptions = new Promise<unknown>((resolve) => {
			sent = resolve;
		});
		// Only the members the extension uses; the session-level delivery of steered messages is core behavior.
		const pi = {
			registerTool: (definition: ToolDefinition) => {
				tool = definition;
			},
			on: () => () => {},
			getSettings: () => ({}),
			sendMessage: (_message: unknown, options: unknown) => sent(options),
		} as unknown as ExtensionAPI;
		createJobsExtension({ operations })(pi);

		await tool!.execute("call-1", { action: "start", command: "npm test" }, undefined, undefined, {
			cwd: "/repo",
		} as ExtensionToolContext);
		exit(0);

		expect(await sentOptions).toEqual({ deliverAs: "steer" });
	});
});
