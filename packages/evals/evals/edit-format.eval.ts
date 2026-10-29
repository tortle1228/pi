// Edit-format benchmark: how reliably a model applies exact edits with each `editMode`.
//
// Run: PI_PROVIDER=anthropic PI_MODEL=claude-sonnet-5-5 PI_EVAL_EDIT_FORMAT=hashline npm run eval:edit -w packages/evals
// PI_EVAL_EDIT_TASKS (default 30) sets how many fixture tasks run, picked evenly across categories. Each run appends
// one line per task to .eval/edit-format/results.jsonl; `npm run eval:edit:report` summarizes them.

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import {
	EDIT_RESULTS_PATH,
	type EditTask,
	gradeEdit,
	loadEditTasks,
	selectEditTasks,
} from "../src/edit-format.ts";
import { createPiCodingAgentHarness, resolveModelSelection } from "../src/harness.ts";

const EDIT_FORMATS = ["replace", "hashline"] as const;
type EditFormat = (typeof EDIT_FORMATS)[number];

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const format = resolveEditFormat(process.env.PI_EVAL_EDIT_FORMAT);
const taskCount = Number(process.env.PI_EVAL_EDIT_TASKS ?? 30);
const model = resolveModelSelection(undefined);
const resultsFile = join(packageDir, EDIT_RESULTS_PATH);
const tasks = selectEditTasks(
	await loadEditTasks(join(packageDir, "evals", "edit-format", "fixtures.tar.gz"), join(packageDir, ".eval", "edit-format")),
	taskCount,
);

function resolveEditFormat(value: string | undefined): EditFormat {
	const formatName = value ?? "replace";
	if ((EDIT_FORMATS as readonly string[]).includes(formatName)) return formatName as EditFormat;
	throw new TypeError(`PI_EVAL_EDIT_FORMAT must be one of ${EDIT_FORMATS.join(", ")}.`);
}

function registerTask(task: EditTask): void {
	const harness = createPiCodingAgentHarness({
		name: `${format}:${task.id}`,
		tools: ["read", "edit", "write"],
		settings: { editMode: format },
		workspaceFiles: { [task.fileName]: task.input },
		output: async ({ session }) => {
			const path = join(session.sessionManager.getCwd(), task.fileName);
			const grade = gradeEdit(task, existsSync(path) ? await readFile(path, "utf8") : undefined);
			const calls = session.messages.flatMap((message) =>
				message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [],
			);
			const failedEdits = session.messages.filter(
				(message): message is ToolResultMessage =>
					message.role === "toolResult" && message.toolName === "edit" && message.isError,
			).length;
			const stats = session.getSessionStats();
			return {
				...grade,
				editCalls: calls.filter((call) => call.name === "edit").length,
				failedEdits,
				writeCalls: calls.filter((call) => call.name === "write").length,
				toolCalls: calls.length,
				inputTokens: stats.tokens.input,
				outputTokens: stats.tokens.output,
			};
		},
	});

	describeEval(`Edit format ${format}: ${task.id}`, { harness }, (it) => {
		it("restores the original file", async ({ run }) => {
			const base = { ...model, format, task: task.id, category: task.category };
			await mkdir(dirname(resultsFile), { recursive: true });
			let result: Awaited<ReturnType<typeof run>>;
			try {
				result = await run(task.prompt);
			} catch (error) {
				// A run that fails, such as on a provider error, counts as a failed task rather than a missing one.
				const record = { ...base, exact: false, normalized: false, error: String(error) };
				await appendFile(resultsFile, `${JSON.stringify(record)}\n`);
				throw error;
			}
			await appendFile(resultsFile, `${JSON.stringify({ ...base, ...result.output })}\n`);
			expect(result.output.exact).toBe(true);
		});
	});
}

for (const task of tasks) registerTask(task);
