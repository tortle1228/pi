import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { Settings } from "../../src/core/settings-schema.ts";
import { createLspExtension } from "../../src/extensions/lsp/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const FAKE_SERVER = fileURLToPath(new URL("../fixtures/fake-lsp-server.mjs", import.meta.url));

function resultText(harness: Harness, index: number): string {
	const results = harness.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult",
	);
	return results[index].content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("AgentSession LSP diagnostics", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});

	async function setup(lsp: Settings["lsp"]) {
		const harness = await createHarness({ settings: { lsp }, extensionFactories: [createLspExtension()] });
		harnesses.push(harness);
		return harness;
	}

	const fakeServer = { command: [process.execPath, FAKE_SERVER, "push"], extensions: [".fake"] };

	it("appends the new content's errors to edit and write results, and nothing once the file is clean", async () => {
		const harness = await setup({ enabled: true, servers: { fake: fakeServer } });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.fake", content: "ok\nbad ERROR\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "a.fake", edits: [{ oldText: "bad ERROR", newText: "good" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(resultText(harness, 0)).toMatch(
			/\n\nLSP fake found 1 error in a\.fake:\na\.fake:2:5 error \[fake 1\]: found ERROR$/,
		);
		expect(resultText(harness, 1)).not.toContain("LSP");
	});

	it("adds nothing while lsp.enabled is off", async () => {
		const harness = await setup({ servers: { fake: fakeServer } });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.fake", content: "ERROR\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(resultText(harness, 0)).not.toContain("LSP");
	});

	it("says once that a server is not installed", async () => {
		const harness = await setup({
			enabled: true,
			servers: { missing: { command: ["pi-no-such-language-server"], extensions: [".fake"] } },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.fake", content: "ERROR\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write", { path: "b.fake", content: "ERROR\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(resultText(harness, 0)).toContain(
			"[LSP missing: pi-no-such-language-server is not installed, so .fake files are not checked. Install it, or turn it off with lsp.servers.missing.disabled.]",
		);
		expect(resultText(harness, 1)).not.toContain("LSP");
	});
});
