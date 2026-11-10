/**
 * Background shell tasks for the `task` tool: starts commands without waiting for them, keeps each task's output until
 * the model reads it, and stops every task and deletes its log when the session ends.
 */

import type { WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { TextDecoder } from "node:util";
import type { BashOperations } from "../../core/tools/bash.ts";
import { SecretOutputRedactor } from "../../core/tools/secret-output-redactor.ts";
import { truncateTail } from "../../core/tools/truncate.ts";
import { createOutputFileStream } from "../../utils/output-files.ts";

export type TaskStatus =
	| { state: "running" }
	| { state: "exited"; exitCode: number }
	| { state: "cancelled"; reason?: string }
	| { state: "failed"; error: string };

/** When pi stops a task itself: past its run time or its log-size cap, both set per task start. 0 disables a cap. */
export interface TaskLimits {
	maxRunMs: number;
	maxLogBytes: number;
}

/** What the tool reports about a task. */
export interface TaskSnapshot {
	id: string;
	command: string;
	status: TaskStatus;
	/** Seconds since start, or the run time once the task ended. */
	elapsedSeconds: number;
	/** The task's whole output. */
	logPath: string;
}

/** A task's output since the previous read. */
export interface TaskOutput extends TaskSnapshot {
	/** The end of the unread output, within the usual tool output limits. */
	output: string;
	/** Whether earlier unread output is left out of `output`; `logPath` has it. */
	truncated: boolean;
}

/** Unread output beyond this is dropped from memory; the log file keeps it. */
const MAX_UNREAD_CHARS = 1024 * 1024;

interface Task {
	id: string;
	command: string;
	status: TaskStatus;
	startedAt: number;
	endedAt?: number;
	unread: string;
	/** Characters dropped from `unread` since the previous read. */
	droppedChars: number;
	decoder: TextDecoder;
	log: { path: string; stream: WriteStream };
	abort: AbortController;
	/** Why pi stopped the task, when it did: recorded in its status and output. */
	stopReason?: string;
	/** `read` calls waiting for this task to end; they report the end themselves. */
	waitingReads: number;
	/** Settles when the process has exited, the status is final, and the log file is complete. */
	done: Promise<void>;
}

/** Called when a task ends on its own, that is not through `cancel` or `dispose`, and no `read` is waiting for it. */
export type TaskEndListener = (task: TaskSnapshot) => void;

/** The tasks of one session. */
export class TaskRegistry {
	private readonly operations: BashOperations;
	private readonly onEnd: TaskEndListener | undefined;
	private readonly shouldRedact: (() => boolean) | undefined;
	private readonly limits: (() => TaskLimits) | undefined;
	private readonly tasks = new Map<string, Task>();
	private nextId = 1;

	/** `shouldRedact` is asked once per task whether to mask credentials in its output, as `shellRedactSecrets` does. */
	constructor(
		operations: BashOperations,
		onEnd?: TaskEndListener,
		shouldRedact?: () => boolean,
		limits?: () => TaskLimits,
	) {
		this.operations = operations;
		this.onEnd = onEnd;
		this.shouldRedact = shouldRedact;
		this.limits = limits;
	}

	/** Starts `command` in `cwd` and returns at once. `commandPrefix` runs first and `env` applies, as for the bash tool. */
	start(command: string, cwd: string, commandPrefix?: string, env?: NodeJS.ProcessEnv): TaskSnapshot {
		const id = `task-${this.nextId++}`;
		const abort = new AbortController();
		const task: Task = {
			id,
			command,
			status: { state: "running" },
			startedAt: Date.now(),
			unread: "",
			droppedChars: 0,
			decoder: new TextDecoder(),
			log: createOutputFileStream("pi-task", ".log"),
			abort,
			waitingReads: 0,
			done: Promise.resolve(),
		};
		// The caps are read per task, like the shell, so a settings change reaches tasks started after it.
		const limits = this.limits?.() ?? { maxRunMs: 0, maxLogBytes: 0 };
		// A delay above setTimeout's 2^31-1 ms limit fires at once; settings are not validated at runtime, so clamp.
		const maxRunMs = Math.min(limits.maxRunMs, 2 ** 31 - 1);
		let logBytes = 0;
		let acceptingOutput = true;
		// Redaction runs before the log and the unread buffer, so neither ever holds a credential.
		const redactor = this.shouldRedact?.() ? new SecretOutputRedactor() : undefined;
		const append = (text: string) => {
			if (redactor) task.log.stream.write(text);
			this.appendUnread(task, text);
		};
		const onData = (data: Buffer) => {
			if (!acceptingOutput) return;
			if (!redactor) task.log.stream.write(data);
			logBytes += data.length;
			const text = task.decoder.decode(data, { stream: true });
			append(redactor ? redactor.push(text) : text);
			// The cap checks streamed output as it arrives; the trailing flush of a partial line cannot cross it.
			if (limits.maxLogBytes > 0 && logBytes > limits.maxLogBytes) {
				stop(`reached the ${formatBytes(limits.maxLogBytes)} log-size cap (tasks.maxLogBytes)`);
			}
		};
		/** Stops the task on pi's own initiative, so the reason reaches its status, its output and its log. */
		const stop = (reason: string) => {
			// A task already cancelled, by the user or the session end, is not re-marked as a cap stop: the cap timer
			// can fire in the window between that abort and the process settling.
			if (task.status.state !== "running" || abort.signal.aborted) return;
			task.stopReason = reason;
			const note = `\n[pi stopped this task: ${reason}.]\n`;
			task.log.stream.write(note);
			this.appendUnread(task, note);
			abort.abort();
		};
		// Without a listener, a stream error such as a full disk is an uncaught exception that ends all of pi.
		task.log.stream.on("error", (error) => stop(`could not write its log: ${error.message}`));
		const timer =
			limits.maxRunMs > 0
				? setTimeout(
						() =>
							stop(
								`reached the ${Math.max(1, Math.round(maxRunMs / 60000))}-minute run-time cap (tasks.maxRunMinutes)`,
							),
						maxRunMs,
					)
				: undefined;
		// The cap must not keep the process alive on its own; dispose clears the timer when the session ends.
		timer?.unref();
		const script = commandPrefix ? `${commandPrefix}\n${command}` : command;
		task.done = this.operations
			.exec(script, cwd, { onData, signal: abort.signal, env })
			.then(
				({ exitCode }): TaskStatus =>
					abort.signal.aborted
						? { state: "cancelled", ...(task.stopReason ? { reason: task.stopReason } : {}) }
						: { state: "exited", exitCode: exitCode ?? 1 },
				(error: unknown): TaskStatus =>
					abort.signal.aborted
						? { state: "cancelled", ...(task.stopReason ? { reason: task.stopReason } : {}) }
						: { state: "failed", error: error instanceof Error ? error.message : String(error) },
			)
			.then((status) => {
				acceptingOutput = false;
				clearTimeout(timer);
				const rest = task.decoder.decode();
				append(redactor ? redactor.push(rest) + redactor.finish() : rest);
				task.status = status;
				task.endedAt = Date.now();
				// A pi-stopped task ended on its own from the model's point of view, so it is reported like an exit.
				if ((status.state !== "cancelled" || task.stopReason) && task.waitingReads === 0) {
					this.onEnd?.(this.snapshot(task));
				}
				return new Promise<void>((resolve) => task.log.stream.end(resolve));
			});
		this.tasks.set(id, task);
		return this.snapshot(task);
	}

	/**
	 * Returns the output added since the previous read. With `waitMs`, first waits until the task ends or the time is
	 * up; an aborted `signal` ends the wait early but leaves the task running.
	 */
	async read(id: string, waitMs: number, signal?: AbortSignal): Promise<TaskOutput> {
		const task = this.get(id);
		if (waitMs > 0 && task.status.state === "running") {
			task.waitingReads++;
			try {
				await waitFor(task.done, waitMs, signal);
			} finally {
				task.waitingReads--;
			}
		}
		const unread = task.unread;
		const dropped = task.droppedChars;
		task.unread = "";
		task.droppedChars = 0;
		const truncation = truncateTail(unread);
		return { ...this.snapshot(task), output: truncation.content, truncated: truncation.truncated || dropped > 0 };
	}

	/** Stops the task and its child processes, then reports its final state. */
	async cancel(id: string): Promise<TaskSnapshot> {
		const task = this.get(id);
		if (task.status.state === "running") {
			task.abort.abort();
			await task.done;
		}
		return this.snapshot(task);
	}

	list(): TaskSnapshot[] {
		return [...this.tasks.values()].map((task) => this.snapshot(task));
	}

	/** Stops every running task and deletes every log, which can reach `tasks.maxLogBytes` each; for session end. */
	async dispose(): Promise<void> {
		const tasks = [...this.tasks.values()];
		const running = tasks.filter((task) => task.status.state === "running");
		for (const task of running) task.abort.abort();
		await Promise.all(running.map((task) => task.done));
		await Promise.all(tasks.map((task) => rm(task.log.path, { force: true }).catch(() => {})));
	}

	private get(id: string): Task {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Unknown task: ${id}. Use action "list" to see the tasks.`);
		return task;
	}

	private appendUnread(task: Task, text: string): void {
		if (!text) return;
		task.unread += text;
		const excess = task.unread.length - MAX_UNREAD_CHARS;
		if (excess > 0) {
			task.unread = task.unread.slice(excess);
			task.droppedChars += excess;
		}
	}

	private snapshot(task: Task): TaskSnapshot {
		const elapsedMs = (task.endedAt ?? Date.now()) - task.startedAt;
		return {
			id: task.id,
			command: task.command,
			status: task.status,
			elapsedSeconds: Math.round(elapsedMs / 100) / 10,
			logPath: task.log.path,
		};
	}
}

/** Bytes as `1 KiB`, `512 MiB` or `1.5 MiB`, for the reason a cap stopped a task. */
function formatBytes(bytes: number): string {
	const kib = bytes / 1024;
	if (kib < 1024) return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
	const mib = kib / 1024;
	return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

/** Resolves when `promise` settles, `ms` pass, or `signal` aborts, whichever comes first. */
function waitFor(promise: Promise<void>, ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
		void promise.then(finish);
	});
}
