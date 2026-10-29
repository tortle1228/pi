/**
 * The edit-format benchmark: loads the fixture tasks, picks a stable sample, and grades the file an agent edited.
 *
 * Fixtures come from oh-my-pi's typescript-edit-benchmark (MIT, see `evals/edit-format/NOTICE.md`): each task is one
 * TypeScript file with injected bugs and a prompt that names the exact change. A task passes when the edited file
 * equals the original.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the edit-format eval appends one JSON line per task run, relative to the evals package. */
export const EDIT_RESULTS_PATH = ".eval/edit-format/results.jsonl";

export interface EditTask {
	/** Fixture directory name, such as `operator-swap-comparison-001`. */
	id: string;
	/** The fixture name without its number, such as `operator-swap-comparison`. */
	category: string;
	prompt: string;
	/** The file the task edits, relative to the workspace, with its mutated content. */
	fileName: string;
	input: string;
	/** The original content the edit should restore. */
	expected: string;
}

/** Extracts `tarball` into `cacheDir` once and returns the fixture tasks sorted by id. */
export async function loadEditTasks(tarball: string, cacheDir: string): Promise<EditTask[]> {
	const fixturesDir = join(cacheDir, "fixtures");
	if (!existsSync(fixturesDir)) {
		await mkdir(cacheDir, { recursive: true });
		const extract = spawnSync("tar", ["xzf", tarball, "-C", cacheDir], { stdio: "inherit" });
		if (extract.status !== 0) throw new Error(`Could not extract ${tarball} (tar exited with ${extract.status})`);
	}
	const ids = (await readdir(fixturesDir, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	return Promise.all(
		ids.map(async (id) => {
			const dir = join(fixturesDir, id);
			const [fileName] = await readdir(join(dir, "input"));
			const [prompt, input, expected] = await Promise.all([
				readFile(join(dir, "prompt.md"), "utf8"),
				readFile(join(dir, "input", fileName), "utf8"),
				readFile(join(dir, "expected", fileName), "utf8"),
			]);
			return { id, category: id.replace(/-\d+$/, ""), prompt, fileName, input, expected };
		}),
	);
}

/**
 * Picks `count` tasks that cover the categories evenly: one task of each category in turn, in id order. The same
 * inputs always give the same sample, so runs of different models and formats are comparable.
 */
export function selectEditTasks(tasks: readonly EditTask[], count: number): EditTask[] {
	const byCategory = new Map<string, EditTask[]>();
	for (const task of tasks) byCategory.set(task.category, [...(byCategory.get(task.category) ?? []), task]);
	const queues = [...byCategory.values()];
	const selected: EditTask[] = [];
	for (let round = 0; selected.length < count && queues.some((queue) => round < queue.length); round++) {
		for (const queue of queues) {
			if (selected.length === count) break;
			if (round < queue.length) selected.push(queue[round]);
		}
	}
	return selected;
}

export interface EditGrade {
	/** The edited file equals the original exactly. */
	exact: boolean;
	/** It equals the original ignoring trailing whitespace and blank-line count, as oh-my-pi's grading does for code. */
	normalized: boolean;
}

/** Grades `actual`, the content of the task file after the agent ran, or undefined when the file is gone. */
export function gradeEdit(task: EditTask, actual: string | undefined): EditGrade {
	if (actual === undefined) return { exact: false, normalized: false };
	return { exact: actual === task.expected, normalized: normalize(actual) === normalize(task.expected) };
}

function normalize(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line !== "")
		.join("\n");
}

/** One line of the results file. Metric fields are missing when the run failed before grading. */
export interface EditResultRecord {
	provider: string;
	id: string;
	format: string;
	task: string;
	exact: boolean;
	normalized: boolean;
	error?: string;
	editCalls?: number;
	failedEdits?: number;
	writeCalls?: number;
	inputTokens?: number;
	outputTokens?: number;
}

export interface EditResultSummary {
	provider: string;
	model: string;
	format: string;
	runs: number;
	exactRate: number;
	normalizedRate: number;
	errors: number;
	/** Edit calls per run. */
	editCalls: number;
	/** Share of edit calls that failed, such as stale tags or text that did not match. */
	failedEditRate: number;
	/** Share of runs that used write, which bypasses the edit format. */
	writeRate: number;
	inputTokens: number;
	outputTokens: number;
}

/** Summarizes records per provider, model, and format; the latest record of a task counts when it ran more than once. */
export function summarizeEditResults(records: readonly EditResultRecord[]): EditResultSummary[] {
	const latest = new Map<string, EditResultRecord>();
	for (const record of records)
		latest.set(`${record.provider}\0${record.id}\0${record.format}\0${record.task}`, record);
	const groups = new Map<string, EditResultRecord[]>();
	for (const record of latest.values()) {
		const key = `${record.provider}\0${record.id}\0${record.format}`;
		groups.set(key, [...(groups.get(key) ?? []), record]);
	}
	const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
	return [...groups.values()]
		.map((group) => {
			const graded = group.filter((record) => record.error === undefined);
			const editCalls = graded.reduce((sum, record) => sum + (record.editCalls ?? 0), 0);
			return {
				provider: group[0].provider,
				model: group[0].id,
				format: group[0].format,
				runs: group.length,
				exactRate: group.filter((record) => record.exact).length / group.length,
				normalizedRate: group.filter((record) => record.normalized).length / group.length,
				errors: group.length - graded.length,
				editCalls: mean(graded.map((record) => record.editCalls ?? 0)),
				failedEditRate:
					editCalls === 0 ? 0 : graded.reduce((sum, record) => sum + (record.failedEdits ?? 0), 0) / editCalls,
				writeRate:
					graded.length === 0 ? 0 : graded.filter((record) => (record.writeCalls ?? 0) > 0).length / graded.length,
				inputTokens: mean(graded.map((record) => record.inputTokens ?? 0)),
				outputTokens: mean(graded.map((record) => record.outputTokens ?? 0)),
			};
		})
		.sort(
			(a, b) =>
				a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.format.localeCompare(b.format),
		);
}
