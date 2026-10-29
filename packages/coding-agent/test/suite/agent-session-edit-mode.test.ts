import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession editMode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("gives read tagged lines and edit tag addressing with editMode hashline", async () => {
		const harness = await createHarness({ settings: { editMode: "hashline" } });
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "a.txt"), "one\ntwo\n");
		// The edit uses the tag from the read result the model actually received.
		const editFromRead = (context: TranscriptContext) => {
			const result = context.messages.findLast(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			const shown = result?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
			const start = /^(\d+#[a-z]{2})\|two$/m.exec(shown)?.[1] ?? "missing";
			return fauxAssistantMessage([fauxToolCall("edit", { path: "a.txt", edits: [{ start, newText: "TWO" }] })], {
				stopReason: "toolUse",
			});
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
			editFromRead,
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(readFileSync(join(harness.tempDir, "a.txt"), "utf-8")).toBe("one\nTWO\n");
		const edit = harness.session.agent.state.tools.find((tool) => tool.name === "edit");
		expect(JSON.stringify(edit?.parameters)).toContain('"start"');
	});
});
