import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ENVIRONMENT_CONTEXT_MESSAGE_TYPE,
	environmentContextMessageIfChanged,
	resolveEnvironmentContext,
} from "../src/core/environment-context.ts";
import { type CustomMessage, convertToLlm } from "../src/core/messages.ts";
import { buildSystemPrompt, buildSystemPromptSections } from "../src/core/system-prompt.ts";
import { createHarness } from "./suite/harness.ts";

describe("Dynamic Prompt & Byte-Stable Cache", () => {
	describe("Byte-Stability of System Prompt", () => {
		it("produces byte-identical system prompt across different working directories", () => {
			const promptDirA = buildSystemPrompt({
				cwd: "/Users/alice/projectA",
				selectedTools: ["read", "bash", "edit", "write"],
			});

			const promptDirB = buildSystemPrompt({
				cwd: "/home/bob/workspace/projectB",
				selectedTools: ["read", "bash", "edit", "write"],
			});

			expect(promptDirA).toBe(promptDirB);
		});

		it("does not render cwd inside system prompt sections by default", () => {
			const sections = buildSystemPromptSections({
				cwd: "/Users/test/path",
				selectedTools: ["read", "bash", "edit", "write"],
			});

			expect(sections.cwd).toBeUndefined();
			expect(Object.keys(sections)).not.toContain("cwd");
		});

		it("renders cwd inside system prompt sections when includeCwd is true", () => {
			const sections = buildSystemPromptSections({
				cwd: "/Users/test/path",
				includeCwd: true,
				selectedTools: ["read", "bash", "edit", "write"],
			});

			expect(sections.cwd).toBe("<cwd>\n/Users/test/path\n</cwd>");
		});
	});

	describe("Dynamic Discipline Sections", () => {
		it("includes intent_gate, working_task, verification, and handoff sections", () => {
			const sections = buildSystemPromptSections({
				cwd: "/test",
				selectedTools: ["read", "bash", "edit", "write"],
			});

			// Verify presence of all four discipline tags
			expect(sections.intent_gate).toBeDefined();
			expect(sections.working_task).toBeDefined();
			expect(sections.verification).toBeDefined();
			expect(sections.handoff).toBeDefined();

			// Structural checks without pinning long prose
			expect(sections.intent_gate).toContain("<intent_gate>");
			expect(sections.intent_gate).toContain("Information & Diagnosis");
			expect(sections.intent_gate).toContain("Verification");
			expect(sections.intent_gate).toContain("Judgment");
			expect(sections.intent_gate).toContain("Change");
			expect(sections.intent_gate).toContain("Operational & Git");

			expect(sections.working_task).toContain("<working_task>");
			expect(sections.working_task).toContain("parallel wave");

			expect(sections.verification).toContain("<verification>");
			expect(sections.verification).toContain("V1");
			expect(sections.verification).toContain("V2");
			expect(sections.verification).toContain("V3");
			expect(sections.verification).toContain("Test Discipline");

			expect(sections.handoff).toContain("<handoff>");
			expect(sections.handoff).toContain("Ask:");
		});
	});

	describe("Environment Context & Message Folding", () => {
		it("resolves local date correctly in non-UTC timezones even in early morning", () => {
			vi.stubEnv("TZ", "Asia/Seoul");
			try {
				// 03:00 AM KST on Oct 29 (which is Oct 28 18:00 UTC)
				const earlyMorning = new Date("2026-10-29T03:00:00+09:00");
				const context = resolveEnvironmentContext("/test", earlyMorning);
				expect(context.currentDate).toBe("2026-10-29");
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("creates environment context message once and skips when unchanged", () => {
			const context = resolveEnvironmentContext("/Users/alice/projectA");
			const msg1 = environmentContextMessageIfChanged([], context);

			expect(msg1).toBeDefined();
			expect(msg1?.customType).toBe(ENVIRONMENT_CONTEXT_MESSAGE_TYPE);
			expect(msg1?.details).toEqual(context);
			expect(msg1?.display).toBe(false);

			// When already present in history, returns undefined
			const msg2 = environmentContextMessageIfChanged([msg1!], context);
			expect(msg2).toBeUndefined();

			// When directory changes, creates new message
			const context2 = resolveEnvironmentContext("/Users/alice/projectB");
			const msg3 = environmentContextMessageIfChanged([msg1!], context2);
			expect(msg3).toBeDefined();
			expect(msg3?.details).toEqual(context2);
		});

		it("folds environment context message into the subsequent user message for LLM", () => {
			const context = resolveEnvironmentContext("/Users/alice/projectA");
			const envMsg = environmentContextMessageIfChanged([], context)!;

			const userMsg = {
				role: "user" as const,
				content: [{ type: "text" as const, text: "Hello, please list files" }],
				timestamp: Date.now(),
			};

			const llmMessages = convertToLlm([envMsg, userMsg]);

			// Exactly one user message should be sent to the LLM (folded!)
			expect(llmMessages).toHaveLength(1);
			expect(llmMessages[0].role).toBe("user");

			// The content should contain environment_context block as the leading block
			const content = llmMessages[0].content as Array<{ type: string; text: string }>;
			expect(content).toHaveLength(2);
			expect(content[0].text).toContain("<environment_context>");
			expect(content[0].text).toContain("<cwd>/Users/alice/projectA</cwd>");
			expect(content[1].text).toBe("Hello, please list files");
		});

		it("preserves standalone environment context if no user message follows", () => {
			const context = resolveEnvironmentContext("/Users/alice/projectA");
			const envMsg = environmentContextMessageIfChanged([], context)!;

			const llmMessages = convertToLlm([envMsg]);
			expect(llmMessages).toHaveLength(1);
			expect(llmMessages[0].role).toBe("user");
		});
	});

	describe("End-to-End Session Prompt with Byte-Stable Cache & Dynamic Discipline", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("carries environment context on turn 1 and omits on turn 2, keeping system prompt stable", async () => {
			vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
			vi.setSystemTime(new Date("2026-10-29T12:00:00"));

			const receivedRequests: Array<{ systemPrompt: string; messages: Message[] }> = [];

			const harness = await createHarness({
				environmentContext: true,
				dynamicDiscipline: true,
			});

			try {
				harness.setResponses([
					(context) => {
						receivedRequests.push({
							systemPrompt: getCurrentSystemPrompt(context.messages),
							messages: [...context.messages],
						});
						return fauxAssistantMessage("acknowledged turn 1");
					},
					(context) => {
						receivedRequests.push({
							systemPrompt: getCurrentSystemPrompt(context.messages),
							messages: [...context.messages],
						});
						return fauxAssistantMessage("acknowledged turn 2");
					},
				]);

				// Turn 1
				await harness.session.prompt("Explain the code in index.ts");

				expect(receivedRequests).toHaveLength(1);
				const req1 = receivedRequests[0];

				// System prompt has dynamic discipline, but no cwd
				expect(req1.systemPrompt).toContain("<intent_gate>");
				expect(req1.systemPrompt).toContain("<verification>");
				expect(req1.systemPrompt).toContain("<handoff>");
				expect(req1.systemPrompt).not.toContain("<cwd>");

				// First user message has folded environment_context
				const userTurn1 = req1.messages.find((m) => m.role === "user");
				expect(userTurn1).toBeDefined();
				const content1 = userTurn1!.content as Array<{ type: string; text: string }>;
				expect(content1[0].text).toContain("<environment_context>");
				expect(content1[0].text).toContain(harness.tempDir.replace(/\\/g, "/"));
				expect(content1[1].text).toBe("Explain the code in index.ts");

				// Turn 2
				await harness.session.prompt("Now add a helper");

				expect(receivedRequests).toHaveLength(2);
				const req2 = receivedRequests[1];

				// System prompt is byte-identical to turn 1!
				expect(req2.systemPrompt).toBe(req1.systemPrompt);

				// Second user message does NOT contain environment_context (already known)
				const userMessages = req2.messages.filter((m) => m.role === "user");
				const userTurn2 = userMessages[userMessages.length - 1];
				expect(userTurn2).toBeDefined();
				const content2 = userTurn2!.content as Array<{ type: string; text: string }>;
				expect(content2).toHaveLength(1);
				expect(content2[0].text).toBe("Now add a helper");
				expect(content2[0].text).not.toContain("<environment_context>");
			} finally {
				harness.cleanup();
			}
		});

		it("re-injects environment context on the next prompt after compaction drops it", async () => {
			vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
			vi.setSystemTime(new Date("2026-10-29T12:00:00"));

			let compacted = false;
			const requests: Message[][] = [];
			const harness = await createHarness({
				environmentContext: true,
				extensionFactories: [
					(pi) => {
						// Compact the whole history, including the first env message, after the first turn.
						pi.on("turn_end", () => {
							if (compacted) return;
							compacted = true;
							return {
								entries: [{ type: "compaction", summary: "first turn summary", firstKeptEntryId: null }],
								continue: false,
							};
						});
					},
				],
			});

			try {
				harness.setResponses([
					fauxAssistantMessage("first reply"),
					(context) => {
						requests.push([...context.messages]);
						return fauxAssistantMessage("second reply");
					},
				]);

				await harness.session.prompt("first prompt");
				await harness.session.prompt("second prompt");

				expect(requests).toHaveLength(1);
				const wire = JSON.stringify(requests[0]);
				expect(wire).toContain("first turn summary");
				expect(wire).not.toContain("first prompt");
				expect(wire.split("<environment_context>")).toHaveLength(2);

				const lastUser = requests[0].filter((m) => m.role === "user").at(-1);
				const blocks = lastUser?.content as Array<{ type: string; text: string }>;
				expect(blocks[0].text).toContain("<environment_context>");
				expect(blocks[1].text).toBe("second prompt");
			} finally {
				harness.cleanup();
			}
		});

		it("injects environment context on custom-triggered runs and folds into wire message", async () => {
			let deliveredUserContent: string | undefined;

			const harness = await createHarness({
				environmentContext: true,
			});

			try {
				harness.setResponses([
					(context) => {
						const firstUser = context.messages.find((m) => m.role === "user");
						if (firstUser) {
							const textBlocks = Array.isArray(firstUser.content)
								? firstUser.content.map((b) => (b.type === "text" ? b.text : "")).join("\n")
								: String(firstUser.content);
							deliveredUserContent = textBlocks;
						}
						return fauxAssistantMessage("acknowledged");
					},
				]);

				// Trigger a run with custom message
				await harness.session.sendCustomMessage(
					{
						customType: "test-event",
						content: "custom trigger payload",
						display: false,
					},
					{ triggerTurn: true },
				);

				// 1. Session history records the custom environment context message
				const customMessages = harness.session.messages.filter(
					(m): m is CustomMessage => m.role === "custom" && m.customType === ENVIRONMENT_CONTEXT_MESSAGE_TYPE,
				);
				expect(customMessages).toHaveLength(1);
				expect((customMessages[0].details as { cwd: string }).cwd).toBe(harness.tempDir.replace(/\\/g, "/"));

				// 2. Wire request delivered to LLM has the folded environment context block
				expect(deliveredUserContent).toBeDefined();
				expect(deliveredUserContent).toContain("<environment_context>");
				expect(deliveredUserContent).toContain(harness.tempDir.replace(/\\/g, "/"));
				expect(deliveredUserContent).toContain("custom trigger payload");
			} finally {
				harness.cleanup();
			}
		});

		// Runs one prompt with the given prompt settings and no SDK override, so only the settings path decides.
		async function firstRequestWithPromptSettings(prompt: {
			environmentContext: boolean;
			dynamicDiscipline: boolean;
		}): Promise<{ systemPrompt: string; userText: string }> {
			const harness = await createHarness({ settings: { prompt } });
			let systemPrompt = "";
			let userText = "";
			try {
				harness.setResponses([
					(context) => {
						systemPrompt = getCurrentSystemPrompt(context.messages);
						const firstUser = context.messages.find((m) => m.role === "user");
						if (firstUser) {
							userText = Array.isArray(firstUser.content)
								? firstUser.content.map((b) => (b.type === "text" ? b.text : "")).join("\n")
								: String(firstUser.content);
						}
						return fauxAssistantMessage("hello");
					},
				]);
				await harness.session.prompt("hi");
			} finally {
				harness.cleanup();
			}
			return { systemPrompt, userText };
		}

		it("disables environmentContext and dynamicDiscipline via settings", async () => {
			const { systemPrompt, userText } = await firstRequestWithPromptSettings({
				environmentContext: false,
				dynamicDiscipline: false,
			});

			expect(systemPrompt).not.toContain("<intent_gate>");
			expect(systemPrompt).not.toContain("<verification>");
			expect(systemPrompt).not.toContain("<handoff>");
			expect(systemPrompt).toContain("<cwd>");
			expect(userText).toBe("hi");
		});

		it("enables environmentContext and dynamicDiscipline via settings", async () => {
			const { systemPrompt, userText } = await firstRequestWithPromptSettings({
				environmentContext: true,
				dynamicDiscipline: true,
			});

			expect(systemPrompt).toContain("<intent_gate>");
			expect(systemPrompt).toContain("<verification>");
			expect(systemPrompt).toContain("<handoff>");
			expect(systemPrompt).not.toContain("<cwd>");
			expect(userText).toContain("<environment_context>");
			expect(userText).toContain("hi");
		});
	});
});
