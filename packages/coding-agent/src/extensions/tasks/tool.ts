/** The `tasks` tool: starts shell commands in the background and reads, lists, or cancels them later. */

import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { resolveSpawnContext } from "../../core/tools/bash.ts";
import type { TaskOutput, TaskRegistry, TaskSnapshot, TaskStatus } from "./task-registry.ts";
import type { WaitStop } from "./wait-stop.ts";

export const TASK_TOOL_NAME = "tasks";

/** `customType` of the message that reports a task which ended on its own. */
export const TASK_ENDED_MESSAGE_TYPE = "task-ended";

/** The text of that message. */
export function formatTaskEnded(task: TaskSnapshot): string {
	return `Background ${describeTask(task)}: ${task.command}\nRead its output with the tasks tool, action "output" and id "${task.id}".`;
}

/** First line of an `output` wait the user's message ended while the task still ran. */
export const STOPPED_WAITING =
	'Stopped waiting: the user typed a message. The task keeps running; read it later with action "output".';

/** The longest `wait`, so a forgotten task cannot hold a turn indefinitely. */
const MAX_WAIT_SECONDS = 600;

const taskSchema = Type.Object({
	action: Type.Union([Type.Literal("start"), Type.Literal("output"), Type.Literal("cancel"), Type.Literal("list")], {
		description:
			"start: run command in the background; output: read a task's new output; cancel: stop a task; list: show all tasks",
	}),
	command: Type.Optional(Type.String({ description: "Shell command to run (start)" })),
	id: Type.Optional(Type.String({ description: 'Task id returned by start, such as "task-1" (output, cancel)' })),
	wait: Type.Optional(
		Type.Number({
			description: `Seconds to wait for the task to end before returning its new output (output; default 0, at most ${MAX_WAIT_SECONDS})`,
		}),
	),
});

export type TaskToolInput = Static<typeof taskSchema>;

export type TaskToolDetails = { tasks: TaskSnapshot[] };

export const taskToolSystemPromptContribution = {
	snippet: "Run shell commands in the background and read their output later",
	guidelines: [
		"Use tasks for commands that keep running, such as dev servers and watchers, or that take longer than you want to wait for; use bash for everything else.",
		'Read a task with action "output"; set wait to block until it ends instead of polling in a loop.',
	],
} as const;

export interface TaskToolOptions {
	registry: TaskRegistry;
	/** Prefix prepended to every command, as for the bash tool. */
	getCommandPrefix: () => string | undefined;
	/** Whether the `bash` tool is active. `start` needs it: turning bash off must also turn off this way to run commands. */
	isBashActive: () => boolean;
	/** Ends `output` waits when the user types. */
	waitStop: WaitStop;
}

export function createTaskToolDefinition(options: TaskToolOptions): ToolDefinition<typeof taskSchema, TaskToolDetails> {
	const { registry, waitStop } = options;
	return {
		name: TASK_TOOL_NAME,
		label: "tasks",
		description: `Run shell commands in the background. "start" returns a task id at once; "output" returns what the task printed since the previous read, within the usual output limits, and the full output is kept in a log file; "cancel" stops the task and its child processes; "list" shows every task. Tasks stop when the session ends, or earlier at the tasks.maxRunMinutes and tasks.maxLogBytes caps.`,
		promptSnippet: taskToolSystemPromptContribution.snippet,
		promptGuidelines: [...taskToolSystemPromptContribution.guidelines],
		parameters: taskSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				case "start": {
					if (!params.command) throw new Error('action "start" needs command');
					if (!options.isBashActive()) {
						throw new Error('action "start" needs the bash tool, which is turned off in this session');
					}
					const { env } = resolveSpawnContext(params.command, ctx.cwd, undefined, true, ctx);
					const task = registry.start(params.command, ctx.cwd, options.getCommandPrefix(), env);
					const text = `Started ${task.id}: ${params.command}\nRead its output with action "output" and id "${task.id}".`;
					return { content: [{ type: "text", text }], details: { tasks: [task] } };
				}
				case "output": {
					const waitSeconds = Math.min(Math.max(params.wait ?? 0, 0), MAX_WAIT_SECONDS);
					const read = (stop?: AbortSignal) => registry.read(requireId(params), waitSeconds * 1000, stop);
					const { value: task, stopped } = await waitStop.run(signal, read);
					return {
						content: [{ type: "text", text: formatOutput(task, stopped) }],
						details: { tasks: [task] },
					};
				}
				case "cancel": {
					const task = await registry.cancel(requireId(params));
					return { content: [{ type: "text", text: describeTask(task) }], details: { tasks: [task] } };
				}
				case "list": {
					const tasks = registry.list();
					const text = tasks.length > 0 ? tasks.map(formatListLine).join("\n") : "No tasks";
					return { content: [{ type: "text", text }], details: { tasks } };
				}
			}
		},
	};
}

function requireId(params: TaskToolInput): string {
	if (!params.id) throw new Error(`action "${params.action}" needs id`);
	return params.id;
}

function formatOutput(task: TaskOutput, stoppedByUser: boolean): string {
	const lines = [describeTask(task), task.output || "(no new output)"];
	if (stoppedByUser && task.status.state === "running") {
		lines.splice(1, 0, "", STOPPED_WAITING);
	}
	if (task.truncated) lines.push(`[Earlier output not shown. Full output: ${task.logPath}]`);
	return lines.join("\n");
}

/** One line such as `task-1 exited with code 0 after 3.2s`. */
export function describeTask(task: TaskSnapshot): string {
	return `${task.id} ${describeStatus(task.status)} ${task.status.state === "running" ? "for" : "after"} ${task.elapsedSeconds}s`;
}

function describeStatus(status: TaskStatus): string {
	switch (status.state) {
		case "running":
			return "running";
		case "exited":
			return `exited with code ${status.exitCode}`;
		case "cancelled":
			return status.reason ? `cancelled (${status.reason})` : "cancelled";
		case "failed":
			return `failed (${status.error})`;
	}
}

/** One line such as `task-1 exited with code 0 after 3.2s: npm test`, for lists of tasks. */
export function formatListLine(task: TaskSnapshot): string {
	const command = task.command.replace(/\s+/g, " ");
	return `${describeTask(task)}: ${command.length > 80 ? `${command.slice(0, 77)}...` : command}`;
}
