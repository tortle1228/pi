import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { TaskRegistry, type TaskSnapshot } from "../src/extensions/tasks/task-registry.ts";

/** A started command whose output and exit the test controls. */
interface FakeRun {
	command: string;
	signal: AbortSignal | undefined;
	write(text: string): void;
	exit(exitCode: number): void;
	fail(error: Error): void;
}

/** Operations that never spawn: each exec becomes a FakeRun; an abort rejects like the local shell does. */
function fakeOperations(): { operations: BashOperations; runs: FakeRun[] } {
	const runs: FakeRun[] = [];
	const operations: BashOperations = {
		exec: (command, _cwd, { onData, signal }) =>
			new Promise((resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				runs.push({
					command,
					signal,
					write: (text) => onData(Buffer.from(text)),
					exit: (exitCode) => resolve({ exitCode }),
					fail: reject,
				});
			}),
	};
	return { operations, runs };
}

describe("TaskRegistry", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts a task without waiting for it and prepends the command prefix", () => {
		const { operations, runs } = fakeOperations();
		const registry = new TaskRegistry(operations);

		const task = registry.start("npm run dev", "/repo", "shopt -s expand_aliases");

		expect(task).toMatchObject({ id: "task-1", command: "npm run dev", status: { state: "running" } });
		expect(runs[0].command).toBe("shopt -s expand_aliases\nnpm run dev");
		expect(registry.start("second", "/repo").id).toBe("task-2");
	});

	it("returns only the output added since the previous read", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new TaskRegistry(operations);
		registry.start("server", "/repo");

		runs[0].write("listening\n");
		expect(await registry.read("task-1", 0)).toMatchObject({ output: "listening\n", truncated: false });
		expect((await registry.read("task-1", 0)).output).toBe("");
		runs[0].write("GET /\n");
		expect((await registry.read("task-1", 0)).output).toBe("GET /\n");
	});

	it("waits for the task to end before reading", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new TaskRegistry(operations);
		registry.start("build", "/repo");

		const reading = registry.read("task-1", 60_000);
		runs[0].write("done\n");
		runs[0].exit(2);

		expect(await reading).toMatchObject({ output: "done\n", status: { state: "exited", exitCode: 2 } });
	});

	it("stops waiting when the wait time is up or the signal aborts, and leaves the task running", async () => {
		vi.useFakeTimers();
		const { operations } = fakeOperations();
		const registry = new TaskRegistry(operations);
		registry.start("watch", "/repo");

		const timedOut = registry.read("task-1", 5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect((await timedOut).status).toEqual({ state: "running" });

		const controller = new AbortController();
		const aborted = registry.read("task-1", 60_000, controller.signal);
		controller.abort();
		expect((await aborted).status).toEqual({ state: "running" });
	});

	it("cancels a task, and dispose cancels every running task", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new TaskRegistry(operations);
		registry.start("one", "/repo");
		registry.start("two", "/repo");
		registry.start("three", "/repo");
		runs[2].exit(0);

		expect((await registry.cancel("task-1")).status).toEqual({ state: "cancelled" });
		expect(runs[0].signal?.aborted).toBe(true);

		await registry.dispose();
		expect(runs[1].signal?.aborted).toBe(true);
		expect(runs[2].signal?.aborted).toBe(false);
		expect(registry.list().map((task) => task.status.state)).toEqual(["cancelled", "cancelled", "exited"]);
	});

	it("reports a task that could not run", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new TaskRegistry(operations);
		registry.start("missing", "/gone");

		runs[0].fail(new Error("Working directory does not exist: /gone"));

		expect((await registry.read("task-1", 60_000)).status).toEqual({
			state: "failed",
			error: "Working directory does not exist: /gone",
		});
	});

	it("shows the end of long output and keeps all of it in the log file", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new TaskRegistry(operations);
		registry.start("noisy", "/repo");
		const lines = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`);

		runs[0].write(`${lines.join("\n")}\n`);
		runs[0].exit(0);
		const result = await registry.read("task-1", 60_000);

		expect(result.truncated).toBe(true);
		expect(result.output.startsWith("line 1001\n")).toBe(true);
		expect(result.output.endsWith("line 3000")).toBe(true);
		expect(readFileSync(result.logPath, "utf-8")).toBe(`${lines.join("\n")}\n`);
	});

	it("reports tasks that end on their own, but not cancelled ones or ones a read waits for", async () => {
		const { operations, runs } = fakeOperations();
		const ended: string[] = [];
		let onNextEnd: (() => void) | undefined;
		const nextEnd = () =>
			new Promise<void>((resolve) => {
				onNextEnd = resolve;
			});
		const registry = new TaskRegistry(operations, (task) => {
			ended.push(`${task.id} ${task.status.state}`);
			onNextEnd?.();
		});
		for (const command of ["exits", "fails", "cancelled", "awaited", "disposed"]) registry.start(command, "/repo");

		let ending = nextEnd();
		runs[0].exit(0);
		await ending;
		ending = nextEnd();
		runs[1].fail(new Error("spawn failed"));
		await ending;
		await registry.cancel("task-3");
		const awaited = registry.read("task-4", 60_000);
		runs[3].exit(1);
		await awaited;
		await registry.dispose();

		expect(ended).toEqual(["task-1 exited", "task-2 failed"]);
	});

	it("masks credentials in the output and the log file when redaction is on", async () => {
		// Assembled at runtime so no credential-shaped literal is committed.
		const secret = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
		for (const redact of [true, false]) {
			const { operations, runs } = fakeOperations();
			const registry = new TaskRegistry(operations, undefined, () => redact);
			registry.start("printenv", "/repo");
			runs[0].write(`token ${secret.slice(0, 10)}`);
			runs[0].write(`${secret.slice(10)}\n`);
			runs[0].exit(0);
			const result = await registry.read("task-1", 60_000);
			const expected = redact ? "token <redacted>\n" : `token ${secret}\n`;
			expect(result.output).toBe(expected);
			expect(readFileSync(result.logPath, "utf-8")).toBe(expected);
		}
	});

	it("ignores output delivered after the task settles", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new TaskRegistry(operations);
		registry.start("done", "/repo");
		runs[0].exit(0);
		await registry.read("task-1", 60_000);
		runs[0].write("late");
		expect((await registry.read("task-1", 0)).output).toBe("");
	});

	it("deletes every log at dispose, of finished tasks too", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new TaskRegistry(operations);
		const finished = registry.start("done", "/repo");
		const running = registry.start("server", "/repo");
		runs[0].write("kept until the session ends\n");
		runs[0].exit(0);
		await registry.read(finished.id, 60_000);
		expect(existsSync(finished.logPath)).toBe(true);

		await registry.dispose();

		expect(existsSync(finished.logPath)).toBe(false);
		expect(existsSync(running.logPath)).toBe(false);
	});

	it("stops the task instead of crashing when its log cannot be written", async () => {
		vi.stubEnv("TMPDIR", join(process.cwd(), "missing-pi-task-log-dir"));
		try {
			const { operations } = fakeOperations();
			const registry = new TaskRegistry(operations);
			registry.start("server", "/repo");
			const { status } = await registry.read("task-1", 60_000);
			expect(status).toMatchObject({
				state: "cancelled",
				reason: expect.stringContaining("could not write its log"),
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("passes the environment to the command", () => {
		let received: NodeJS.ProcessEnv | undefined;
		const registry = new TaskRegistry({
			exec: (_command, _cwd, { env }) => {
				received = env;
				return new Promise(() => {});
			},
		});
		registry.start("server", "/repo", undefined, { PI_MODEL: "m" });
		expect(received).toEqual({ PI_MODEL: "m" });
	});

	it("rejects an unknown task id", async () => {
		const registry = new TaskRegistry(fakeOperations().operations);
		await expect(registry.read("task-9", 0)).rejects.toThrow(
			'Unknown task: task-9. Use action "list" to see the tasks.',
		);
		await expect(registry.cancel("task-9")).rejects.toThrow("Unknown task: task-9");
	});
});

describe("TaskRegistry caps", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Operations whose run settles `settleAfterAbortMs` after the abort, so a cap timer can fire in between. */
	function slowAbortOperations(settleAfterAbortMs: number): BashOperations {
		return {
			exec: (_command, _cwd, { signal }) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => setTimeout(() => reject(new Error("aborted")), settleAfterAbortMs),
						{ once: true },
					);
				}),
		};
	}

	it("never reports a user-cancelled task as stopped at the run-time cap", async () => {
		vi.useFakeTimers();
		const ended: string[] = [];
		const registry = new TaskRegistry(
			slowAbortOperations(200),
			(task) => ended.push(task.id),
			undefined,
			() => ({ maxRunMs: 300, maxLogBytes: 0 }),
		);
		registry.start("watch", "/repo");

		// The user cancels at 300 ms - 100; the run settles 200 ms after the abort, so the cap timer fires at
		// 300 ms inside the settling window.
		await vi.advanceTimersByTimeAsync(200);
		const cancelling = registry.cancel("task-1");
		await vi.advanceTimersByTimeAsync(300);
		await cancelling;

		const result = await registry.read("task-1", 0);
		expect(result.status).toEqual({ state: "cancelled" });
		expect(result.output).not.toContain("pi stopped this task");
		expect(ended).toEqual([]);
	});

	it("stops a task at its run-time cap and says why in its output and log", async () => {
		vi.useFakeTimers();
		const { operations, runs } = fakeOperations();
		const registry = new TaskRegistry(operations, undefined, undefined, () => ({
			maxRunMs: 5 * 60_000,
			maxLogBytes: 0,
		}));
		registry.start("npm run dev", "/repo");

		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(runs[0].signal?.aborted).toBe(true);

		const result = await registry.read("task-1", 60_000);
		expect(result.status).toEqual({
			state: "cancelled",
			reason: "reached the 5-minute run-time cap (tasks.maxRunMinutes)",
		});
		expect(result.output).toContain(
			"[pi stopped this task: reached the 5-minute run-time cap (tasks.maxRunMinutes).",
		);
	});

	it("stops a task at its log-size cap, but only once", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new TaskRegistry(operations, undefined, undefined, () => ({
			maxRunMs: 0,
			maxLogBytes: 1024 * 1024,
		}));
		registry.start("yes", "/repo");

		runs[0].write("a".repeat(1024 * 1024 + 1));
		expect(runs[0].signal?.aborted).toBe(true);

		const result = await registry.read("task-1", 60_000);
		expect(result.status).toEqual({
			state: "cancelled",
			reason: "reached the 1 MiB log-size cap (tasks.maxLogBytes)",
		});
		// The note is appended once, not once per streamed chunk.
		expect(result.output.match(/pi stopped this task/g)).toHaveLength(1);
		// The task's own output and the note both reach the log file.
		const log = readFileSync(result.logPath, "utf-8");
		expect(log.startsWith("a")).toBe(true);
		expect(log).toContain("[pi stopped this task: reached the 1 MiB log-size cap (tasks.maxLogBytes).");
	});

	it("reports a task it stopped itself, as a task that ended on its own", async () => {
		vi.useFakeTimers();
		const { operations } = fakeOperations();
		const ended: TaskSnapshot[] = [];
		const registry = new TaskRegistry(
			operations,
			(task) => ended.push(task),
			undefined,
			() => ({ maxRunMs: 60_000, maxLogBytes: 0 }),
		);
		registry.start("npm run dev", "/repo");

		await vi.advanceTimersByTimeAsync(60_000);

		expect(ended.map((task) => task.status)).toEqual([
			{ state: "cancelled", reason: "reached the 1-minute run-time cap (tasks.maxRunMinutes)" },
		]);
	});

	it("runs without caps when both are 0 or unset", async () => {
		vi.useFakeTimers();
		const { operations } = fakeOperations();
		const registry = new TaskRegistry(operations, undefined, undefined, () => ({
			maxRunMs: 0,
			maxLogBytes: 0,
		}));
		registry.start("watch", "/repo");

		await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

		expect(registry.list()[0].status).toEqual({ state: "running" });
	});

	it("clamps an oversized run-time cap instead of stopping the task at once", async () => {
		vi.useFakeTimers();
		const { operations, runs } = fakeOperations();
		// 100000 minutes would overflow setTimeout's delay limit, which fires the timer immediately.
		const registry = new TaskRegistry(operations, undefined, undefined, () => ({
			maxRunMs: 100_000 * 60_000,
			maxLogBytes: 0,
		}));
		registry.start("watch", "/repo");

		await vi.advanceTimersByTimeAsync(5_000);
		expect(registry.list()[0].status).toEqual({ state: "running" });
		expect(runs[0].signal?.aborted).toBe(false);

		// The cap still applies, at the clamped delay.
		await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
		expect(runs[0].signal?.aborted).toBe(true);
	});
});
