import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lineTag } from "../src/core/tools/hashline.ts";
import { createAllToolDefinitions, createAllTools } from "../src/core/tools/index.ts";

function text(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The tag that `output` shows for the line with `content`, as a model would pick it. */
function tagOf(output: string, content: string): string {
	const line = output
		.split("\n")
		.map((entry) => entry.replace(/\r$/, ""))
		.find((entry) => entry.endsWith(`|${content}`) || entry.endsWith(`: ${content}`));
	if (!line) throw new Error(`No line "${content}" in:\n${output}`);
	return /(\d+#[a-z]{2})/.exec(line)![1];
}

describe("hashline edit mode", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-hashline-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const tools = () => createAllTools(dir, { editMode: "hashline" });

	it("tags read output and edits by those tags", async () => {
		writeFileSync(join(dir, "a.ts"), "const a = 1;\nconst b = 2;\n");
		const { read, edit } = tools();

		const shown = text(await read.execute("r1", { path: "a.ts" }));
		expect(shown).toBe(`${lineTag(1, "const a = 1;")}|const a = 1;\n${lineTag(2, "const b = 2;")}|const b = 2;`);

		const result = await edit.execute("e1", {
			path: "a.ts",
			edits: [{ start: tagOf(shown, "const b = 2;"), newText: "const b = 3;" }],
		});
		expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("const a = 1;\nconst b = 3;\n");
		expect(text(result)).toBe(
			`Edited a.ts:\n${lineTag(1, "const a = 1;")}|const a = 1;\n${lineTag(2, "const b = 3;")}|const b = 3;`,
		);
		expect(result.details).toMatchObject({ firstChangedLine: 2 });
	});

	it("numbers tags from the read offset", async () => {
		writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
		const shown = text(await tools().read.execute("r1", { path: "a.txt", offset: 2, limit: 1 }));
		expect(shown.split("\n")[0]).toBe(`${lineTag(2, "two")}|two`);
	});

	it("tags grep matches and context lines", async () => {
		writeFileSync(join(dir, "a.ts"), "before\nneedle here\nafter\n");
		const shown = text(await tools().grep.execute("g1", { pattern: "needle", path: "a.ts", context: 1 }));
		expect(shown).toBe(
			[
				`a.ts-${lineTag(1, "before")}- before`,
				`a.ts:${lineTag(2, "needle here")}: needle here`,
				`a.ts-${lineTag(3, "after")}- after`,
			].join("\n"),
		);
	});

	it("keeps CRLF line ends and a BOM", async () => {
		writeFileSync(join(dir, "win.txt"), "\uFEFFfirst\r\nsecond\r\n");
		const { read, edit } = tools();
		const shown = text(await read.execute("r1", { path: "win.txt" }));

		await edit.execute("e1", {
			path: "win.txt",
			edits: [
				{ start: tagOf(shown, "first"), newText: "FIRST" },
				{ start: tagOf(shown, "second"), insert: "after", newText: "third" },
			],
		});

		expect(readFileSync(join(dir, "win.txt"), "utf-8")).toBe("\uFEFFFIRST\r\nsecond\r\nthird\r\n");
	});

	it("rejects an edit with a stale tag and leaves the file unchanged", async () => {
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		const { read, edit } = tools();
		const shown = text(await read.execute("r1", { path: "a.txt" }));
		writeFileSync(join(dir, "a.txt"), "one\nTWO\n");

		await expect(
			edit.execute("e1", { path: "a.txt", edits: [{ start: tagOf(shown, "two"), newText: "2" }] }),
		).rejects.toThrow(`${lineTag(2, "TWO")}|TWO`);
		expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("one\nTWO\n");
	});

	it("leaves the default replace mode unchanged", async () => {
		writeFileSync(join(dir, "a.txt"), "one\n");
		const definitions = createAllToolDefinitions(dir);
		expect(Object.keys(definitions.edit.parameters.properties.edits.items.properties)).toEqual([
			"oldText",
			"newText",
		]);
		expect(text(await createAllTools(dir).read.execute("r1", { path: "a.txt" }))).toBe("one\n");
		expect(
			Object.keys(
				createAllToolDefinitions(dir, { editMode: "hashline" }).edit.parameters.properties.edits.items.properties,
			),
		).toEqual(["start", "end", "insert", "newText"]);
	});
});
