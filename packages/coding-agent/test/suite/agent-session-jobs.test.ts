import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createJobsExtension } from "../../src/extensions/jobs/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

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
});
