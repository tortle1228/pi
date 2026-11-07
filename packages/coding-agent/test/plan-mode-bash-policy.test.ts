import { describe, expect, it } from "vitest";
import { isSafeCommand } from "../src/extensions/plan-mode/bash-policy.ts";

describe("Plan mode bash policy", () => {
	it.each([
		"ls -la",
		"rg plan src",
		"git status --short",
		"node -v",
		"npm -v",
		"java -version",
		"ls /tmp 2>/dev/null",
		"cat 'a file.txt'",
		"git diff --no-ext-diff --no-textconv",
	])("allows %s", (command) => {
		expect(isSafeCommand(command)).toBe(true);
	});

	it.each([
		"rm file",
		"npm install foo",
		"echo text > file",
		"ls; touch file",
		"ls && node -v",
		"cat a | wc",
		"cat $(touch x)",
		"cat `touch x`",
		"cat a\nls",
		"rg --pre script pattern",
		"find . -delete",
		"awk 'BEGIN {system(\"touch x\")}'",
		"curl -o file https://example.com",
		"git diff",
		"git status --short; touch x",
		"ls 2>/tmp/error",
		"ls 2>/dev/null; ls",
		"cat 'unclosed",
		"node --version extra",
	])("rejects %s", (command) => {
		expect(isSafeCommand(command)).toBe(false);
	});
});
