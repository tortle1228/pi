/** The `job` tool: starts shell commands in the background and reads, lists, or cancels them later. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { JobOutput, JobRegistry, JobSnapshot, JobStatus } from "./job-registry.ts";

export const JOB_TOOL_NAME = "job";

/** `customType` of the message that reports a job which ended on its own. */
export const JOB_ENDED_MESSAGE_TYPE = "job-ended";

/** The text of that message. */
export function formatJobEnded(job: JobSnapshot): string {
	return `Background ${describeJob(job)}: ${job.command}\nRead its output with the job tool, action "output" and id "${job.id}".`;
}

/** The longest `wait`, so a forgotten job cannot hold a turn indefinitely. */
const MAX_WAIT_SECONDS = 600;

const jobSchema = Type.Object({
	action: StringEnum(["start", "output", "cancel", "list"] as const, {
		description:
			"start: run command in the background; output: read a job's new output; cancel: stop a job; list: show all jobs",
	}),
	command: Type.Optional(Type.String({ description: "Shell command to run (start)" })),
	id: Type.Optional(Type.String({ description: 'Job id returned by start, such as "job-1" (output, cancel)' })),
	wait: Type.Optional(
		Type.Number({
			description: `Seconds to wait for the job to end before returning its new output (output; default 0, at most ${MAX_WAIT_SECONDS})`,
		}),
	),
});

export type JobToolInput = Static<typeof jobSchema>;

export type JobToolDetails = { jobs: JobSnapshot[] };

export const jobToolSystemPromptContribution = {
	snippet: "Run shell commands in the background and read their output later",
	guidelines: [
		"Use job for commands that keep running, such as dev servers and watchers, or that take longer than you want to wait for; use bash for everything else.",
		'Read a job with action "output"; set wait to block until it ends instead of polling in a loop.',
	],
} as const;

export interface JobToolOptions {
	registry: JobRegistry;
	/** Prefix prepended to every command, as for the bash tool. */
	getCommandPrefix: () => string | undefined;
}

export function createJobToolDefinition(options: JobToolOptions): ToolDefinition<typeof jobSchema, JobToolDetails> {
	const { registry } = options;
	return {
		name: JOB_TOOL_NAME,
		label: "job",
		description: `Run shell commands in the background. "start" returns a job id at once; "output" returns what the job printed since the previous read, within the usual output limits, and the full output is kept in a log file; "cancel" stops the job and its child processes; "list" shows every job. Jobs stop when the session ends.`,
		promptSnippet: jobToolSystemPromptContribution.snippet,
		promptGuidelines: [...jobToolSystemPromptContribution.guidelines],
		parameters: jobSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				case "start": {
					if (!params.command) throw new Error('action "start" needs command');
					const job = registry.start(params.command, ctx.cwd, options.getCommandPrefix());
					const text = `Started ${job.id}: ${params.command}\nRead its output with action "output" and id "${job.id}".`;
					return { content: [{ type: "text", text }], details: { jobs: [job] } };
				}
				case "output": {
					const waitSeconds = Math.min(Math.max(params.wait ?? 0, 0), MAX_WAIT_SECONDS);
					const job = await registry.read(requireId(params), waitSeconds * 1000, signal);
					return { content: [{ type: "text", text: formatOutput(job) }], details: { jobs: [job] } };
				}
				case "cancel": {
					const job = await registry.cancel(requireId(params));
					return { content: [{ type: "text", text: describeJob(job) }], details: { jobs: [job] } };
				}
				case "list": {
					const jobs = registry.list();
					const text = jobs.length > 0 ? jobs.map(formatListLine).join("\n") : "No jobs";
					return { content: [{ type: "text", text }], details: { jobs } };
				}
			}
		},
	};
}

function requireId(params: JobToolInput): string {
	if (!params.id) throw new Error(`action "${params.action}" needs id`);
	return params.id;
}

function formatOutput(job: JobOutput): string {
	const lines = [describeJob(job), job.output || "(no new output)"];
	if (job.truncated) lines.push(`[Earlier output not shown. Full output: ${job.logPath}]`);
	return lines.join("\n");
}

/** One line such as `job-1 exited with code 0 after 3.2s`. */
export function describeJob(job: JobSnapshot): string {
	return `${job.id} ${describeStatus(job.status)} ${job.status.state === "running" ? "for" : "after"} ${job.elapsedSeconds}s`;
}

function describeStatus(status: JobStatus): string {
	switch (status.state) {
		case "running":
			return "running";
		case "exited":
			return `exited with code ${status.exitCode}`;
		case "cancelled":
			return "cancelled";
		case "failed":
			return `failed (${status.error})`;
	}
}

function formatListLine(job: JobSnapshot): string {
	const command = job.command.replace(/\s+/g, " ");
	return `${describeJob(job)}: ${command.length > 80 ? `${command.slice(0, 77)}...` : command}`;
}
