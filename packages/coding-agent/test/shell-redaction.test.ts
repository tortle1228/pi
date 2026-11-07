import { readFile, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";

const secret = `gh${"p_"}${"A1b2C3d4E5f6g7h8".repeat(3)}`;

function operations(): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from(`before ${secret.slice(0, 12)}`));
			onData(Buffer.from(`${secret.slice(12)}\n${"a".repeat(60000)}\n`));
			return { exitCode: 0 };
		},
	};
}

describe("shell output redaction", () => {
	it.each([createBashTool, createPowerShellTool])("masks streamed, structured and saved output", async (create) => {
		const chunks: string[] = [];
		const tool = create(process.cwd(), { operations: operations() });
		const result = await tool.execute("id", { command: "test" }, undefined, (update) => {
			chunks.push(JSON.stringify(update));
		});
		const details = result.details as { fullOutputPath: string };
		try {
			expect(JSON.stringify(result)).not.toContain(secret);
			expect(chunks.join("")).not.toContain(secret);
			expect(await readFile(details.fullOutputPath, "utf8")).toContain("before <redacted>");
			expect(await readFile(details.fullOutputPath, "utf8")).not.toContain(secret);
		} finally {
			await rm(details.fullOutputPath, { force: true });
		}
	});

	it("masks user bash output and its saved log, and allows opting out", async () => {
		const chunks: string[] = [];
		const result = await executeBashWithOperations("test", process.cwd(), operations(), {
			onChunk: (s) => chunks.push(s),
		});
		try {
			expect(result.output).not.toContain(secret);
			expect(chunks.join("")).not.toContain(secret);
			await vi.waitFor(async () =>
				expect(await readFile(result.fullOutputPath!, "utf8")).toContain("before <redacted>"),
			);
			const raw = await executeBashWithOperations("test", process.cwd(), operations(), { redactSecrets: false });
			try {
				await vi.waitFor(async () => expect(await readFile(raw.fullOutputPath!, "utf8")).toContain(secret));
			} finally {
				await rm(raw.fullOutputPath!, { force: true });
			}
		} finally {
			await rm(result.fullOutputPath!, { force: true });
		}
	});
});
