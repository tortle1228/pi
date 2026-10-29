import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { JobRegistry } from "../src/extensions/jobs/job-registry.ts";

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

describe("JobRegistry", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts a job without waiting for it and prepends the command prefix", () => {
		const { operations, runs } = fakeOperations();
		const registry = new JobRegistry(operations);

		const job = registry.start("npm run dev", "/repo", "shopt -s expand_aliases");

		expect(job).toMatchObject({ id: "job-1", command: "npm run dev", status: { state: "running" } });
		expect(runs[0].command).toBe("shopt -s expand_aliases\nnpm run dev");
		expect(registry.start("second", "/repo").id).toBe("job-2");
	});

	it("returns only the output added since the previous read", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new JobRegistry(operations);
		registry.start("server", "/repo");

		runs[0].write("listening\n");
		expect(await registry.read("job-1", 0)).toMatchObject({ output: "listening\n", truncated: false });
		expect((await registry.read("job-1", 0)).output).toBe("");
		runs[0].write("GET /\n");
		expect((await registry.read("job-1", 0)).output).toBe("GET /\n");
	});

	it("waits for the job to end before reading", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new JobRegistry(operations);
		registry.start("build", "/repo");

		const reading = registry.read("job-1", 60_000);
		runs[0].write("done\n");
		runs[0].exit(2);

		expect(await reading).toMatchObject({ output: "done\n", status: { state: "exited", exitCode: 2 } });
	});

	it("stops waiting when the wait time is up or the signal aborts, and leaves the job running", async () => {
		vi.useFakeTimers();
		const { operations } = fakeOperations();
		const registry = new JobRegistry(operations);
		registry.start("watch", "/repo");

		const timedOut = registry.read("job-1", 5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect((await timedOut).status).toEqual({ state: "running" });

		const controller = new AbortController();
		const aborted = registry.read("job-1", 60_000, controller.signal);
		controller.abort();
		expect((await aborted).status).toEqual({ state: "running" });
	});

	it("cancels a job, and dispose cancels every running job", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new JobRegistry(operations);
		registry.start("one", "/repo");
		registry.start("two", "/repo");
		registry.start("three", "/repo");
		runs[2].exit(0);

		expect((await registry.cancel("job-1")).status).toEqual({ state: "cancelled" });
		expect(runs[0].signal?.aborted).toBe(true);

		await registry.dispose();
		expect(runs[1].signal?.aborted).toBe(true);
		expect(runs[2].signal?.aborted).toBe(false);
		expect(registry.list().map((job) => job.status.state)).toEqual(["cancelled", "cancelled", "exited"]);
	});

	it("reports a job that could not run", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new JobRegistry(operations);
		registry.start("missing", "/gone");

		runs[0].fail(new Error("Working directory does not exist: /gone"));

		expect((await registry.read("job-1", 60_000)).status).toEqual({
			state: "failed",
			error: "Working directory does not exist: /gone",
		});
	});

	it("shows the end of long output and keeps all of it in the log file", async () => {
		const { operations, runs } = fakeOperations();
		const registry = new JobRegistry(operations);
		registry.start("noisy", "/repo");
		const lines = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`);

		runs[0].write(`${lines.join("\n")}\n`);
		runs[0].exit(0);
		const result = await registry.read("job-1", 60_000);

		expect(result.truncated).toBe(true);
		expect(result.output.startsWith("line 1001\n")).toBe(true);
		expect(result.output.endsWith("line 3000")).toBe(true);
		expect(readFileSync(result.logPath, "utf-8")).toBe(`${lines.join("\n")}\n`);
	});

	it("reports jobs that end on their own, but not cancelled ones or ones a read waits for", async () => {
		const { operations, runs } = fakeOperations();
		const ended: string[] = [];
		let onNextEnd: (() => void) | undefined;
		const nextEnd = () =>
			new Promise<void>((resolve) => {
				onNextEnd = resolve;
			});
		const registry = new JobRegistry(operations, (job) => {
			ended.push(`${job.id} ${job.status.state}`);
			onNextEnd?.();
		});
		for (const command of ["exits", "fails", "cancelled", "awaited", "disposed"]) registry.start(command, "/repo");

		let ending = nextEnd();
		runs[0].exit(0);
		await ending;
		ending = nextEnd();
		runs[1].fail(new Error("spawn failed"));
		await ending;
		await registry.cancel("job-3");
		const awaited = registry.read("job-4", 60_000);
		runs[3].exit(1);
		await awaited;
		await registry.dispose();

		expect(ended).toEqual(["job-1 exited", "job-2 failed"]);
	});

	it("masks credentials in the output and the log file when redaction is on", async () => {
		// Assembled at runtime so no credential-shaped literal is committed.
		const secret = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
		for (const redact of [true, false]) {
			const { operations, runs } = fakeOperations();
			const registry = new JobRegistry(operations, undefined, () => redact);
			registry.start("printenv", "/repo");
			runs[0].write(`token ${secret.slice(0, 10)}`);
			runs[0].write(`${secret.slice(10)}\n`);
			runs[0].exit(0);
			const result = await registry.read("job-1", 60_000);
			const expected = redact ? "token <redacted>\n" : `token ${secret}\n`;
			expect(result.output).toBe(expected);
			expect(readFileSync(result.logPath, "utf-8")).toBe(expected);
		}
	});

	it("rejects an unknown job id", async () => {
		const registry = new JobRegistry(fakeOperations().operations);
		await expect(registry.read("job-9", 0)).rejects.toThrow('Unknown job: job-9. Use action "list" to see the jobs.');
		await expect(registry.cancel("job-9")).rejects.toThrow("Unknown job: job-9");
	});
});
