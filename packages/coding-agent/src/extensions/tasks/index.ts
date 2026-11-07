/**
 * The `tasks` tool as an extension. The CLI loads it as a built-in extension; SDK users add `createTasksExtension()` to
 * their extension factories.
 *
 * Tasks run with the `shellPath` and `shellCommandPrefix` settings and stop when the session ends. A
 * task that ends on its own is reported with a `task-ended` message.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { type BashOperations, createLocalBashOperations } from "../../core/tools/bash.ts";
import { formatTasksSummary, TASKS_OVERLAY_OPTIONS, TasksOverlay } from "./overlay.ts";
import { TaskRegistry } from "./task-registry.ts";
import { createTaskToolDefinition, formatTaskEnded, TASK_ENDED_MESSAGE_TYPE } from "./tool.ts";
import { WaitStop } from "./wait-stop.ts";

export interface TasksExtensionOptions {
	/** Runs the commands. Default: the local shell. */
	operations?: BashOperations;
}

export function createTasksExtension(options: TasksExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		// Settings are readable only once the extension has loaded, so the shell is resolved per task.
		const operations: BashOperations = options.operations ?? {
			exec: (command, cwd, execOptions) =>
				createLocalBashOperations({ shellPath: pi.getSettings().shellPath }).exec(command, cwd, execOptions),
		};
		// A task that ends on its own is reported to the model: before its next call while it runs, or with the next
		// prompt while idle. It never starts a turn by itself.
		const registry = new TaskRegistry(
			operations,
			(task) =>
				pi.sendMessage(
					{ customType: TASK_ENDED_MESSAGE_TYPE, content: formatTaskEnded(task), display: true, details: task },
					{ deliverAs: "steer" },
				),
			() => pi.getSettings().shellRedactSecrets ?? true,
			() => ({
				maxRunMs: (pi.getSettings().tasks?.maxRunMinutes ?? SETTINGS_DEFAULTS.tasks.maxRunMinutes) * 60_000,
				maxLogBytes: pi.getSettings().tasks?.maxLogBytes ?? SETTINGS_DEFAULTS.tasks.maxLogBytes,
			}),
		);
		// Text the user types while the run goes on ends an `output` wait, so the model reads the message instead of
		// holding the turn for up to `wait` seconds; the task keeps running. Extension input is not the user's.
		const waitStop = new WaitStop();
		pi.on("input", (event) => {
			if (event.streamingBehavior && event.source !== "extension") waitStop.userInput();
		});
		pi.on("message_end", (event) => {
			if (event.message.role === "user") waitStop.clear();
		});
		pi.on("agent_end", () => waitStop.clear());
		pi.registerTool(
			createTaskToolDefinition({
				registry,
				getCommandPrefix: () => pi.getSettings().shellCommandPrefix,
				isBashActive: () => pi.getActiveTools().includes("bash"),
				waitStop,
			}),
		);
		// The command is there whether or not the tool is active, so tasks can be watched and stopped anyway.
		pi.registerCommand("tasks", {
			description: "List this session's background tasks; stop one from the list",
			handler: async (_args, ctx) => {
				const tasks = registry.list();
				if (tasks.length === 0) {
					ctx.ui.notify("No background tasks in this session.", "info");
					return;
				}
				if (ctx.mode !== "tui") {
					ctx.ui.notify(formatTasksSummary(tasks), "info");
					return;
				}
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) =>
						new TasksOverlay(
							tui,
							theme,
							keybindings,
							() => registry.list(),
							(id) => registry.cancel(id),
							() => done(),
						),
					{ overlay: true, overlayOptions: TASKS_OVERLAY_OPTIONS },
				);
			},
		});
		// Reload, new, resume, and fork replace this extension instance, so its tasks would be unreachable.
		pi.on("session_shutdown", () => registry.dispose());
	};
}

export default createTasksExtension();
