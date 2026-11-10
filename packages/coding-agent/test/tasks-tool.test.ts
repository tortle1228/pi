import { describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { TaskRegistry } from "../src/extensions/tasks/task-registry.ts";
import { createTaskToolDefinition, STOPPED_WAITING } from "../src/extensions/tasks/tool.ts";
import { WaitStop } from "../src/extensions/tasks/wait-stop.ts";

/** Waits until `signal` aborts, as a wait for a task that never ends does. */
const untilAborted = (signal: AbortSignal) =>
	new Promise<string>((resolve) => {
		if (signal.aborted) resolve("ended");
		signal.addEventListener("abort", () => resolve("ended"), { once: true });
	});

describe("WaitStop", () => {
	it("ends an open wait when the user types", async () => {
		const waitStop = new WaitStop();
		const waiting = waitStop.run(undefined, untilAborted);
		waitStop.userInput();
		await expect(waiting).resolves.toEqual({ value: "ended", stopped: true });
	});

	it("ends a wait that opens before the message is read, and later waits run normally", async () => {
		const waitStop = new WaitStop();
		waitStop.userInput();
		await expect(waitStop.run(undefined, untilAborted)).resolves.toEqual({ value: "ended", stopped: true });

		waitStop.clear();
		await expect(waitStop.run(undefined, async () => "read")).resolves.toEqual({ value: "read", stopped: false });
	});

	it("does not report the caller's own abort as user input", async () => {
		const controller = new AbortController();
		const waiting = new WaitStop().run(controller.signal, untilAborted);
		controller.abort();
		await expect(waiting).resolves.toEqual({ value: "ended", stopped: false });
	});
});

describe("task tool output", () => {
	it("stops waiting when the user types and leaves the task running", async () => {
		const signals: Array<AbortSignal | undefined> = [];
		const operations: BashOperations = {
			exec: (_command, _cwd, { signal }) => {
				signals.push(signal);
				return new Promise(() => {});
			},
		};
		const registry = new TaskRegistry(operations);
		const waitStop = new WaitStop();
		const tool = createTaskToolDefinition({
			registry,
			getCommandPrefix: () => undefined,
			isBashActive: () => true,
			waitStop,
		});
		expect(tool.name).toBe("task");
		expect(tool.label).toBe("task");
		registry.start("server", "/repo");

		const output = tool.execute(
			"call",
			{ action: "output", id: "task-1", wait: 600 },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		// The wait opens on a later tick than this call; `pending` covers input that arrives first.
		waitStop.userInput();
		const result = await output;

		expect((result.content[0] as { text: string }).text).toContain(STOPPED_WAITING);
		expect(result.details?.tasks[0].status).toEqual({ state: "running" });
		expect(signals[0]?.aborted).toBe(false);
	});
});
