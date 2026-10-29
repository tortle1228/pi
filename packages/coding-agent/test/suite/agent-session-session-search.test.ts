import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createSessionSearchExtension } from "../../src/extensions/session-search/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe("AgentSession session retrieval tools", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("registers tools inactive and allows explicit activation", async () => {
		const plain = await createHarness({ extensionFactories: [createSessionSearchExtension()] });
		harnesses.push(plain);
		expect(plain.session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["session_search", "session_read"]),
		);
		expect(plain.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		const enabled = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "session_search", "session_read"],
			extensionFactories: [createSessionSearchExtension()],
		});
		harnesses.push(enabled);
		expect(enabled.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "session_search", "session_read"]),
		);
	});

	it("executes search and branch reading through actual agent tool calls without modifying the source", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-session-tools-"));
		directories.push(root);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		const sessionDir = join(root, "sessions");
		const harness = await createHarness({
			sessionManager: SessionManager.create(root, sessionDir),
			initialActiveToolNames: ["session_search", "session_read"],
			extensionFactories: [createSessionSearchExtension()],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const timestamp = "2026-10-01T00:00:00.000Z";
		const file = join(sessionDir, "history.jsonl");
		const bytes = [
			{ type: "session", version: 3, id: "history", cwd: harness.tempDir, timestamp },
			{
				type: "message",
				id: "a",
				parentId: null,
				timestamp,
				message: { role: "user", content: "evidence-token", timestamp: Date.parse(timestamp) },
			},
			{
				type: "message",
				id: "b",
				parentId: "a",
				timestamp,
				message: { role: "user", content: "branch-token", timestamp: Date.parse(timestamp) },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n");
		await writeFile(file, bytes);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("session_search", { query: "evidence-token" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("session_read", { sessionId: "history", entryId: "a", leafId: "b" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("retrieve evidence");
		const searchResult = getToolResult(harness, "session_search");
		const readResult = getToolResult(harness, "session_read");
		expect(searchResult.isError).toBe(false);
		expect(readResult.isError).toBe(false);
		const searchData: unknown = JSON.parse(getMessageText(searchResult));
		const readData: unknown = JSON.parse(getMessageText(readResult));
		expect(searchData).toMatchObject({
			incomplete: false,
			matches: [{ sessionId: "history", entryId: "a", leafId: "b" }],
		});
		expect(readData).toMatchObject({
			entries: [
				{ entryId: "a", text: "evidence-token" },
				{ entryId: "b", text: "branch-token" },
			],
		});
		expect(await readFile(file, "utf8")).toBe(bytes);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
