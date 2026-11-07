import { stripVTControlCharacters } from "node:util";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { formatTasksSummary, OVERLAY_ROWS, TasksOverlay } from "../src/extensions/tasks/overlay.ts";
import type { TaskSnapshot } from "../src/extensions/tasks/task-registry.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";
const X = "x";

function snapshot(id: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id,
		command: `npm run ${id}`,
		status: { state: "running" },
		elapsedSeconds: 3.2,
		logPath: `/tmp/pi-task-${id}.log`,
		...overrides,
	};
}

/** An overlay over `tasks`, read on every render; `stopped` records stop calls, `closed` close calls. */
function overlay(tasks: () => TaskSnapshot[], rows = 40) {
	const stopped: string[] = [];
	const closed = { count: 0 };
	const renders = { count: 0 };
	const tui = { requestRender: () => renders.count++, terminal: { rows } } as unknown as TUI;
	const component = new TasksOverlay(
		tui,
		theme,
		new KeybindingsManager(),
		tasks,
		async (id) => {
			stopped.push(id);
		},
		() => closed.count++,
	);
	const lines = (width = 120) => component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
	return { component, lines, stopped, closed, renders };
}

let open: TasksOverlay[] = [];

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const component of open) component.dispose();
	open = [];
});

function track<T extends { component: TasksOverlay }>(built: T): T {
	open.push(built.component);
	return built;
}

describe("TasksOverlay", () => {
	it("lists the tasks under a header with counts and shows the selected task's details", () => {
		const state = track(
			overlay(() => [
				snapshot("task-1"),
				snapshot("task-2", { status: { state: "exited", exitCode: 0 }, elapsedSeconds: 62 }),
				snapshot("task-3", { status: { state: "failed", error: "spawn failed" } }),
			]),
		);
		const lines = state.lines();

		expect(lines.some((line) => line.includes("Tasks · 1 running · 2 finished"))).toBe(true);
		expect(lines.some((line) => /task-1\s+npm run task-1\s+3\.2s$/.test(line))).toBe(true);
		expect(lines.some((line) => /task-2\s+npm run task-2\s+1m02s$/.test(line))).toBe(true);
		const details = lines.slice(lines.findIndex((line) => line.includes("task-1 · task-1 running for 3.2s")));
		expect(details.some((line) => line.includes("npm run task-1"))).toBe(true);
		expect(details.some((line) => line.includes("log: /tmp/pi-task-task-1.log"))).toBe(true);
		expect(lines.some((line) => line.includes("x stop"))).toBe(true);
	});

	it("moves the selection and stops the selected running task", async () => {
		const state = track(
			overlay(() => [snapshot("task-1", { status: { state: "exited", exitCode: 0 } }), snapshot("task-2")]),
		);
		state.component.handleInput(DOWN);
		state.component.handleInput(X);
		// A task that is not running is not stopped.
		state.component.handleInput(UP);
		state.component.handleInput(X);
		expect(state.stopped).toEqual(["task-2"]);
	});

	it("closes on escape", () => {
		const state = track(overlay(() => [snapshot("task-1")]));
		state.component.handleInput(ESCAPE);
		expect(state.closed.count).toBe(1);
	});

	it("scrolls past the visible rows and says how many are hidden", () => {
		const many = Array.from({ length: OVERLAY_ROWS + 6 }, (_, index) => snapshot(`task-${index + 1}`));
		const state = track(overlay(() => many));
		const first = state.lines();
		expect(first.some((line) => line.includes("↓ 6 more"))).toBe(true);
		expect(first.some((line) => line.includes("↑"))).toBe(false);

		for (let index = 0; index < OVERLAY_ROWS + 5; index++) state.component.handleInput(DOWN);
		const last = state.lines();
		expect(last.some((line) => line.includes("↑ 6 more"))).toBe(true);
		expect(last.some((line) => line.includes("task-16"))).toBe(true);
		expect(last.some((line) => line.includes("↓"))).toBe(false);
	});

	it("fits the overlay's height on a 24-row terminal with rows hidden on both sides", () => {
		const many = Array.from({ length: 30 }, (_, index) =>
			snapshot(`task-${index + 1}`, { command: "x".repeat(300) }),
		);
		const state = track(overlay(() => many, 24));
		for (let index = 0; index < 15; index++) state.component.handleInput(DOWN);
		const lines = state.lines();
		expect(lines.some((line) => line.includes("↑"))).toBe(true);
		expect(lines.some((line) => line.includes("↓"))).toBe(true);
		expect(lines).toHaveLength(Math.floor((24 * 4) / 5));
	});

	it("draws full-width lines, repaints while open, and stops once disposed", () => {
		vi.useFakeTimers();
		const state = track(overlay(() => [snapshot("task-1")]));
		const raw = state.component.render(60);
		for (const line of raw) expect(visibleWidth(line)).toBe(60);

		vi.advanceTimersByTime(80);
		expect(state.renders.count).toBe(1);
		state.component.dispose();
		vi.advanceTimersByTime(80);
		expect(state.renders.count).toBe(1);
		vi.useRealTimers();
	});
});

describe("formatTasksSummary", () => {
	it("leads with the counts, then one line per task as the list action reports it", () => {
		const summary = formatTasksSummary([snapshot("task-1"), snapshot("task-2", { status: { state: "cancelled" } })]);
		expect(summary.split("\n")).toEqual([
			"1 running · 1 finished",
			"task-1 running for 3.2s: npm run task-1",
			"task-2 cancelled after 3.2s: npm run task-2",
		]);
	});

	it("says none when the session has no tasks", () => {
		expect(formatTasksSummary([])).toBe("none");
	});
});
