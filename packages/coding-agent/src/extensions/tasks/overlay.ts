/**
 * The `/tasks` overlay: this session's background tasks, one row each, with the selected task's details below. The
 * `task` tool keeps the tasks; this file only draws them and stops the one the user picks.
 */

import {
	type Component,
	type OverlayOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { formatKeyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { TaskSnapshot, TaskStatus } from "./task-registry.ts";
import { describeTask, formatListLine } from "./tool.ts";

const FRAME_MS = 80;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function rightAlign(left: string, right: string, width: number): string {
	const size = Math.max(0, width - visibleWidth(right) - 1);
	const cut = truncateToWidth(left, size);
	return cut + " ".repeat(Math.max(1, width - visibleWidth(cut) - visibleWidth(right))) + right;
}

/** The overlay's tasks, read on every render, so tasks that end or are stopped appear without their own events. */
export type OverlayTasks = () => TaskSnapshot[];

/** How `/tasks` places the overlay: as `/subagents` does, centered over most of the terminal. */
export const TASKS_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: "80%",
	maxHeight: "80%",
};

/** Task rows visible at once on a tall terminal; the list scrolls past this. */
export const OVERLAY_ROWS = 10;

/** Lines besides the rows and the details: two borders, header and its blank line, both "more" lines, the blanks around the details and the footer. */
const CHROME_LINES = 9;

/**
 * The overlay as text, for modes without one: a header with counts, then one line per task, as the `list` action
 * reports them.
 */
export function formatTasksSummary(tasks: readonly TaskSnapshot[]): string {
	return [counts(tasks) || "none", ...tasks.map(formatListLine)].join("\n");
}

/** The overlay itself: header, a scrolling window of rows, the details of the selected task, and a key hint. */
export class TasksOverlay implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly tasks: OverlayTasks;
	private readonly stop: (id: string) => Promise<unknown>;
	private readonly close: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	/** Index of the selected task. */
	private selected = 0;
	/** Index of the first visible row. */
	private top = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		tasks: OverlayTasks,
		stop: (id: string) => Promise<unknown>,
		close: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.tasks = tasks;
		this.stop = stop;
		this.close = close;
		// One timer for the spinner, the elapsed times and tasks that end while the overlay is open.
		this.timer = setInterval(() => tui.requestRender(), FRAME_MS);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) this.close();
		else if (this.keybindings.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.selected++;
		else if (this.keybindings.matches(data, "app.tasks.stop")) {
			const task = this.tasks()[this.selected];
			if (task?.status.state === "running") void this.stop(task.id);
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const height = Math.floor((this.tui.terminal.rows * 4) / 5);
		const tasks = this.tasks();
		this.selected = Math.min(this.selected, Math.max(0, tasks.length - 1));
		const spinner = SPINNER_FRAMES[Math.floor(Date.now() / FRAME_MS) % SPINNER_FRAMES.length];
		const inner = Math.max(1, width - 2);
		const chosen = tasks[this.selected];
		const details = chosen ? this.details(chosen, inner) : [];
		const rows = Math.max(1, Math.min(OVERLAY_ROWS, height - CHROME_LINES - details.length));
		this.top = Math.min(Math.max(this.top, this.selected - rows + 1), this.selected);

		const lines = [header(tasks, theme), ""];
		if (this.top > 0) lines.push(theme.fg("dim", `↑ ${this.top} more`));
		const end = Math.min(tasks.length, this.top + rows);
		for (let index = this.top; index < end; index++) {
			lines.push(this.row(tasks[index], index === this.selected, spinner, inner));
		}
		if (end < tasks.length) lines.push(theme.fg("dim", `↓ ${tasks.length - end} more`));
		if (details.length > 0) lines.push("", ...details);
		lines.push("", footer(theme, this.keybindings));
		return frame(lines, width, theme);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}

	/** The task's id, command and elapsed time on one line; the state glyph marks the row's left edge. */
	private row(task: TaskSnapshot, selected: boolean, spinner: string, width: number): string {
		const theme = this.theme;
		const marker = selected ? theme.fg("accent", "›") : " ";
		const command = task.command.replace(/\s+/g, " ");
		const left = `${marker} ${taskGlyph(task.status, theme, spinner)} ${theme.fg("dim", task.id)} ${command}`;
		return rightAlign(left, theme.fg("dim", formatElapsed(task.elapsedSeconds)), width);
	}

	/** Status line, up to two lines of the command, and the log path; at most four lines whatever the command. */
	private details(task: TaskSnapshot, width: number): string[] {
		const theme = this.theme;
		const command = wrapTextWithAnsi(task.command.trim(), Math.max(1, width - 2));
		return [
			`${theme.fg("dim", task.id)} ${theme.fg("muted", `· ${describeTask(task)}`)}`,
			...command.slice(0, 2).map((line) => `  ${line}`),
			theme.fg("dim", `  log: ${task.logPath}`),
		];
	}
}

/** `1 running · 2 finished`, or an empty string for no tasks. */
function counts(tasks: readonly TaskSnapshot[]): string {
	const running = tasks.filter((task) => task.status.state === "running").length;
	const finished = tasks.length - running;
	return [running && `${running} running`, finished && `${finished} finished`].filter(Boolean).join(" · ");
}

/** `● Tasks · 1 running · 2 finished`; a plain `● Tasks` when the session has none. */
function header(tasks: readonly TaskSnapshot[], theme: Theme): string {
	const summary = counts(tasks);
	return `${theme.fg("accent", "●")} ${theme.bold("Tasks")}${summary ? theme.fg("muted", ` · ${summary}`) : ""}`;
}

/** The task's state as one colored glyph; `spinner` is the frame shown for a running task. */
function taskGlyph(status: TaskStatus, theme: Theme, spinner: string): string {
	switch (status.state) {
		case "running":
			return theme.fg("accent", spinner);
		case "exited":
			return status.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("warning", "■");
		case "failed":
			return theme.fg("error", "✗");
	}
}

/** `41s`, or `1m02s` from a minute on, for the whole time the task has run so far. */
function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/** `x stop  escape close`, with the keys the user has bound. */
function footer(theme: Theme, keybindings: KeybindingsManager): string {
	const hint = (name: "tui.select.up" | "tui.select.down" | "app.tasks.stop" | "tui.select.cancel") =>
		formatKeyText(keybindings.getKeys(name).join("/"));
	const move = `${hint("tui.select.up")}/${hint("tui.select.down")}`;
	return `${theme.fg("dim", move)}${theme.fg("muted", " select")}  ${theme.fg("dim", hint("app.tasks.stop"))}${theme.fg("muted", " stop")}  ${theme.fg("dim", hint("tui.select.cancel"))}${theme.fg("muted", " close")}`;
}

/** `lines` between top and bottom borders, each filled to the full width: an overlay draws over the chat, which shows through any gap. */
function frame(lines: string[], width: number, theme: Theme): string[] {
	const border = theme.fg("dim", "─".repeat(width));
	return [border, ...lines.map((line) => fill(` ${line}`, width)), border];
}

/** `line` cut or padded with spaces to exactly `width` columns. */
function fill(line: string, width: number): string {
	const cut = truncateToWidth(line, width);
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}
