import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createApplyPatchTool } from "../src/extensions/apply-patch/index.ts";

function text(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("apply_patch", () => {
	let dir: string;
	const tool = createApplyPatchTool();
	const run = (input: string) =>
		tool.execute("call-1", { input }, undefined, undefined, { cwd: dir } as ExtensionToolContext);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-apply-patch-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("declares a Lark grammar, so grammar-capable APIs send it as a freeform tool", () => {
		expect(tool.name).toBe("apply_patch");
		expect(tool.constrainedSampling).toMatchObject({
			type: "grammar",
			variants: { openai_lark: expect.stringContaining("begin_patch") },
		});
	});

	it("adds, updates, moves, and deletes files in one patch", async () => {
		writeFileSync(join(dir, "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
		writeFileSync(join(dir, "old.txt"), "gone\n");

		await run(
			[
				"*** Begin Patch",
				"*** Add File: new.txt",
				"+hello",
				"*** Update File: a.ts",
				"*** Move to: b.ts",
				"@@",
				" const a = 1;",
				"-const b = 2;",
				"+const b = 20;",
				" const c = 3;",
				"*** Delete File: old.txt",
				"*** End Patch",
			].join("\n"),
		);

		expect(readFileSync(join(dir, "new.txt"), "utf-8")).toBe("hello\n");
		expect(readFileSync(join(dir, "b.ts"), "utf-8")).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
		expect(existsSync(join(dir, "a.ts"))).toBe(false);
		expect(existsSync(join(dir, "old.txt"))).toBe(false);
	});

	it("reports a hunk whose context is not in the file and leaves the file unchanged", async () => {
		writeFileSync(join(dir, "a.ts"), "const a = 1;\n");

		const result = await run(
			["*** Begin Patch", "*** Update File: a.ts", "@@", "-const z = 9;", "+const z = 10;", "*** End Patch"].join(
				"\n",
			),
		);

		expect((result.details as { result?: { failures?: unknown[] } }).result?.failures).toHaveLength(1);
		expect(text(result)).toContain("a.ts");
		expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("const a = 1;\n");
	});
});
