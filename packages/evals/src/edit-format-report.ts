// Prints a Markdown table of the edit-format eval results: npm run eval:edit:report -w packages/evals

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EDIT_RESULTS_PATH, type EditResultRecord, summarizeEditResults } from "./edit-format.ts";

const resultsFile = join(fileURLToPath(new URL("..", import.meta.url)), EDIT_RESULTS_PATH);
const records = (await readFile(resultsFile, "utf8"))
	.split("\n")
	.filter((line) => line.trim() !== "")
	.map((line) => JSON.parse(line) as EditResultRecord);

const percent = (value: number) => `${(value * 100).toFixed(0)}%`;
console.log(
	"| Model | Format | Runs | Exact | Normalized | Errors | Edits/run | Failed edits | Used write | Input tok | Output tok |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const row of summarizeEditResults(records)) {
	console.log(
		`| ${row.provider}/${row.model} | ${row.format} | ${row.runs} | ${percent(row.exactRate)} | ${percent(row.normalizedRate)} | ${row.errors} | ${row.editCalls.toFixed(1)} | ${percent(row.failedEditRate)} | ${percent(row.writeRate)} | ${Math.round(row.inputTokens)} | ${Math.round(row.outputTokens)} |`,
	);
}
