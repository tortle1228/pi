// Load the extension in a real agent session and check that the memory reaches the provider request.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import claudeMemory from "../../src/extensions/claude-memory/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("Claude memory in an agent session", () => {
	const previous = { config: process.env.CLAUDE_CONFIG_DIR, disable: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY };
	const harnesses: Harness[] = [];
	let directory: string;

	beforeEach(() => {
		directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-claude-memory-suite-")));
		process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
		delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
		for (const [name, value] of [
			["CLAUDE_CONFIG_DIR", previous.config],
			["CLAUDE_CODE_DISABLE_AUTO_MEMORY", previous.disable],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("puts memory and write guidance into the request the provider receives", async () => {
		const harness = await createHarness({ extensionFactories: [claudeMemory] });
		harnesses.push(harness);
		const memory = join(directory, "claude/projects", harness.tempDir.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
		mkdirSync(memory, { recursive: true });
		writeFileSync(join(memory, "MEMORY.md"), "- [Marker](marker.md) — memory-marker-1234\n");
		let request = "";
		harness.setResponses([
			(context) => {
				request = JSON.stringify(context);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("hello");
		expect(request).toContain("memory-marker-1234");
		expect(request).toContain("Save a memory when the user asks");
		expect(request).toContain(memory);
	});
});
