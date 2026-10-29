import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type EditResultRecord,
	type EditTask,
	gradeEdit,
	loadEditTasks,
	selectEditTasks,
	summarizeEditResults,
} from "../src/edit-format.ts";

const TARBALL = fileURLToPath(new URL("../evals/edit-format/fixtures.tar.gz", import.meta.url));

describe("edit-format fixtures", () => {
	let cache: string;
	let tasks: EditTask[];

	beforeAll(async () => {
		cache = mkdtempSync(join(tmpdir(), "pi-edit-format-"));
		tasks = await loadEditTasks(TARBALL, cache);
	});

	afterAll(() => {
		rmSync(cache, { recursive: true, force: true });
	});

	it("loads every task with a mutated input that differs from the original", () => {
		expect(tasks).toHaveLength(106);
		for (const task of tasks) {
			expect(task.fileName).toMatch(/\.ts$/);
			expect(task.input).not.toBe(task.expected);
			expect(task.prompt).toContain(task.fileName);
		}
	});

	it("selects a stable sample that covers every category before repeating one", () => {
		const sample = selectEditTasks(tasks, 30);
		const categories = new Set(tasks.map((task) => task.category));
		expect(sample).toHaveLength(30);
		expect(new Set(sample.map((task) => task.id)).size).toBe(30);
		expect(new Set(sample.slice(0, categories.size).map((task) => task.category)).size).toBe(categories.size);
		expect(
			selectEditTasks(
				[...tasks].reverse().sort((a, b) => a.id.localeCompare(b.id)),
				30,
			),
		).toEqual(sample);
		expect(selectEditTasks(tasks, 500)).toHaveLength(106);
	});

	it("grades an exact restore, a whitespace-only difference, and a missing file", () => {
		const [task] = tasks;
		expect(gradeEdit(task, task.expected)).toEqual({ exact: true, normalized: true });
		expect(gradeEdit(task, `${task.expected.replace("\n", "\n\n")}  `)).toEqual({ exact: false, normalized: true });
		expect(gradeEdit(task, task.input)).toEqual({ exact: false, normalized: false });
		expect(gradeEdit(task, undefined)).toEqual({ exact: false, normalized: false });
	});
});

describe("summarizeEditResults", () => {
	const record = (overrides: Partial<EditResultRecord>): EditResultRecord => ({
		provider: "anthropic",
		id: "claude-sonnet-5-5",
		format: "hashline",
		task: "t1",
		exact: true,
		normalized: true,
		editCalls: 1,
		failedEdits: 0,
		writeCalls: 0,
		inputTokens: 1000,
		outputTokens: 100,
		...overrides,
	});

	it("aggregates per model and format, counting the latest run of each task and errors as failures", () => {
		const [summary] = summarizeEditResults([
			record({ task: "t1", exact: false, normalized: false }),
			record({ task: "t1", editCalls: 2, failedEdits: 1 }),
			record({
				task: "t2",
				exact: false,
				normalized: true,
				writeCalls: 1,
				inputTokens: 2000,
				cacheReadTokens: 1000,
			}),
			{
				provider: "anthropic",
				id: "claude-sonnet-5-5",
				format: "hashline",
				task: "t3",
				exact: false,
				normalized: false,
				error: "Error: 529",
			},
		]);
		expect(summary).toEqual({
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			format: "hashline",
			runs: 3,
			exactRate: 1 / 3,
			normalizedRate: 2 / 3,
			errors: 1,
			editCalls: 1.5,
			failedEditRate: 1 / 3,
			writeRate: 0.5,
			inputTokens: 2000,
			outputTokens: 100,
		});
	});
});
