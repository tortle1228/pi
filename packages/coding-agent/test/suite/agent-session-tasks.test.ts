import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createTasksExtension } from "../../src/extensions/tasks/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

describe("background tasks in an agent session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("is active by default and executes start and output calls", async () => {
		const harness = await createHarness({ extensionFactories: [createTasksExtension()] });
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).toContain("task");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { action: "start", command: "printf 'hello\\n'" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("task", { action: "output", id: "task-1", wait: 30 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(JSON.stringify(getToolResult(harness, "task"))).toContain("hello");
	});

	it("refuses to start a command when bash is excluded", async () => {
		let started = false;
		const operations: BashOperations = {
			exec: async () => {
				started = true;
				return { exitCode: 0 };
			},
		};
		const harness = await createHarness({
			extensionFactories: [createTasksExtension({ operations })],
			excludedToolNames: ["bash"],
		});
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).toContain("task");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { action: "start", command: "rm -rf build" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(started).toBe(false);
		expect(JSON.stringify(getToolResult(harness, "task"))).toContain("needs the bash tool");
	});

	it("gives a task the session environment the bash tool gets", async () => {
		const harness = await createHarness({ extensionFactories: [createTasksExtension()] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { action: "start", command: 'printf "%s" "$PI_SESSION_ID"' })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("task", { action: "output", id: "task-1", wait: 30 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(JSON.stringify(getToolResult(harness, "task"))).toContain(harness.sessionManager.getSessionId());
	});

	it("stops running work at session shutdown", async () => {
		let signal: AbortSignal | undefined;
		const operations: BashOperations = {
			exec: (_command, _cwd, options) =>
				new Promise((_resolve, reject) => {
					signal = options.signal;
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		};
		const harness = await createHarness({ extensionFactories: [createTasksExtension({ operations })] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { action: "start", command: "server" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("started"),
		]);
		await harness.session.prompt("go");
		expect(signal?.aborted).toBe(false);
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		expect(signal?.aborted).toBe(true);
	});
});
