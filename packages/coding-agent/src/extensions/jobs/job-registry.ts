/**
 * Background shell jobs for the `job` tool: starts commands without waiting for them, keeps each job's output until
 * the model reads it, and stops every job when the session ends.
 */

import type { WriteStream } from "node:fs";
import { TextDecoder } from "node:util";
import type { BashOperations } from "../../core/tools/bash.ts";
import { SecretOutputRedactor } from "../../core/tools/secret-output-redactor.ts";
import { truncateTail } from "../../core/tools/truncate.ts";
import { createOutputFileStream } from "../../utils/output-files.ts";

export type JobStatus =
	| { state: "running" }
	| { state: "exited"; exitCode: number }
	| { state: "cancelled" }
	| { state: "failed"; error: string };

/** What the tool reports about a job. */
export interface JobSnapshot {
	id: string;
	command: string;
	status: JobStatus;
	/** Seconds since start, or the run time once the job ended. */
	elapsedSeconds: number;
	/** The job's whole output. */
	logPath: string;
}

/** A job's output since the previous read. */
export interface JobOutput extends JobSnapshot {
	/** The end of the unread output, within the usual tool output limits. */
	output: string;
	/** Whether earlier unread output is left out of `output`; `logPath` has it. */
	truncated: boolean;
}

/** Unread output beyond this is dropped from memory; the log file keeps it. */
const MAX_UNREAD_CHARS = 1024 * 1024;

interface Job {
	id: string;
	command: string;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	unread: string;
	/** Characters dropped from `unread` since the previous read. */
	droppedChars: number;
	decoder: TextDecoder;
	log: { path: string; stream: WriteStream };
	abort: AbortController;
	/** `read` calls waiting for this job to end; they report the end themselves. */
	waitingReads: number;
	/** Settles when the process has exited, the status is final, and the log file is complete. */
	done: Promise<void>;
}

/** Called when a job ends on its own, that is not through `cancel` or `dispose`, and no `read` is waiting for it. */
export type JobEndListener = (job: JobSnapshot) => void;

/** The jobs of one session. */
export class JobRegistry {
	private readonly operations: BashOperations;
	private readonly onEnd: JobEndListener | undefined;
	private readonly shouldRedact: (() => boolean) | undefined;
	private readonly jobs = new Map<string, Job>();
	private nextId = 1;

	/** `shouldRedact` is asked once per job whether to mask credentials in its output, as `shellRedactSecrets` does. */
	constructor(operations: BashOperations, onEnd?: JobEndListener, shouldRedact?: () => boolean) {
		this.operations = operations;
		this.onEnd = onEnd;
		this.shouldRedact = shouldRedact;
	}

	/** Starts `command` in `cwd` and returns at once. `commandPrefix` runs first, as for the bash tool. */
	start(command: string, cwd: string, commandPrefix?: string): JobSnapshot {
		const id = `job-${this.nextId++}`;
		const abort = new AbortController();
		const job: Job = {
			id,
			command,
			status: { state: "running" },
			startedAt: Date.now(),
			unread: "",
			droppedChars: 0,
			decoder: new TextDecoder(),
			log: createOutputFileStream("pi-job", ".log"),
			abort,
			waitingReads: 0,
			done: Promise.resolve(),
		};
		// Redaction runs before the log and the unread buffer, so neither ever holds a credential.
		const redactor = this.shouldRedact?.() ? new SecretOutputRedactor() : undefined;
		const append = (text: string) => {
			if (redactor) job.log.stream.write(text);
			this.appendUnread(job, text);
		};
		const onData = (data: Buffer) => {
			if (!redactor) job.log.stream.write(data);
			const text = job.decoder.decode(data, { stream: true });
			append(redactor ? redactor.push(text) : text);
		};
		const script = commandPrefix ? `${commandPrefix}\n${command}` : command;
		job.done = this.operations
			.exec(script, cwd, { onData, signal: abort.signal })
			.then(
				({ exitCode }): JobStatus =>
					abort.signal.aborted ? { state: "cancelled" } : { state: "exited", exitCode: exitCode ?? 1 },
				(error: unknown): JobStatus =>
					abort.signal.aborted
						? { state: "cancelled" }
						: { state: "failed", error: error instanceof Error ? error.message : String(error) },
			)
			.then((status) => {
				const rest = job.decoder.decode();
				append(redactor ? redactor.push(rest) + redactor.finish() : rest);
				job.status = status;
				job.endedAt = Date.now();
				if (status.state !== "cancelled" && job.waitingReads === 0) this.onEnd?.(this.snapshot(job));
				return new Promise<void>((resolve) => job.log.stream.end(resolve));
			});
		this.jobs.set(id, job);
		return this.snapshot(job);
	}

	/**
	 * Returns the output added since the previous read. With `waitMs`, first waits until the job ends or the time is
	 * up; an aborted `signal` ends the wait early but leaves the job running.
	 */
	async read(id: string, waitMs: number, signal?: AbortSignal): Promise<JobOutput> {
		const job = this.get(id);
		if (waitMs > 0 && job.status.state === "running") {
			job.waitingReads++;
			try {
				await waitFor(job.done, waitMs, signal);
			} finally {
				job.waitingReads--;
			}
		}
		const unread = job.unread;
		const dropped = job.droppedChars;
		job.unread = "";
		job.droppedChars = 0;
		const truncation = truncateTail(unread);
		return { ...this.snapshot(job), output: truncation.content, truncated: truncation.truncated || dropped > 0 };
	}

	/** Stops the job and its child processes, then reports its final state. */
	async cancel(id: string): Promise<JobSnapshot> {
		const job = this.get(id);
		if (job.status.state === "running") {
			job.abort.abort();
			await job.done;
		}
		return this.snapshot(job);
	}

	list(): JobSnapshot[] {
		return [...this.jobs.values()].map((job) => this.snapshot(job));
	}

	/** Stops every running job; for session end. */
	async dispose(): Promise<void> {
		const running = [...this.jobs.values()].filter((job) => job.status.state === "running");
		for (const job of running) job.abort.abort();
		await Promise.all(running.map((job) => job.done));
	}

	private get(id: string): Job {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Unknown job: ${id}. Use action "list" to see the jobs.`);
		return job;
	}

	private appendUnread(job: Job, text: string): void {
		if (!text) return;
		job.unread += text;
		const excess = job.unread.length - MAX_UNREAD_CHARS;
		if (excess > 0) {
			job.unread = job.unread.slice(excess);
			job.droppedChars += excess;
		}
	}

	private snapshot(job: Job): JobSnapshot {
		const elapsedMs = (job.endedAt ?? Date.now()) - job.startedAt;
		return {
			id: job.id,
			command: job.command,
			status: job.status,
			elapsedSeconds: Math.round(elapsedMs / 100) / 10,
			logPath: job.log.path,
		};
	}
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
