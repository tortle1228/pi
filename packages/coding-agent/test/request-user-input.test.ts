import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import requestUserInput, { formatAnswers } from "../src/extensions/request-user-input/index.ts";
import { type QuestionAnswer, QuestionView } from "../src/extensions/request-user-input/question-view.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";

const QUESTIONS = [
	{
		id: "storage",
		header: "Storage",
		question: "Which local storage format should the notes CLI use?",
		options: [
			{ label: "SQLite (Recommended)", description: "Reliable single-file storage with straightforward querying." },
			{ label: "JSON file", description: "Human-readable single file, with simpler but less robust updates." },
		],
	},
	{
		id: "order",
		header: "Order",
		question: "What should the default note listing order be?",
		options: [
			{ label: "Recently updated", description: "Shows the notes you worked on most recently first." },
			{ label: "Newest created", description: "Shows newly added notes first, regardless of later edits." },
		],
	},
];

function createView(questions = QUESTIONS) {
	const done = vi.fn<(answers: QuestionAnswer[] | undefined) => void>();
	const tui = { requestRender: vi.fn() };
	const view = new QuestionView(questions, tui as never, theme, new KeybindingsManager(), done);
	const screen = (width = 120) => view.render(width).map((line) => stripAnsi(line).trimEnd());
	return { view, done, screen };
}

describe("request_user_input question view", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders the Codex layout with an automatic None of the above", () => {
		const { screen } = createView();
		const lines = screen();

		expect(lines).toContain(" Question 1/2 (2 unanswered)");
		expect(lines).toContain(" Which local storage format should the notes CLI use?");
		expect(lines.some((line) => line.startsWith(" › 1. SQLite (Recommended)"))).toBe(true);
		expect(lines.some((line) => line.startsWith("   3. None of the above"))).toBe(true);
		expect(lines).toContain(
			" tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
		);
	});

	it("frames the panel with borders and highlights the selected row in the theme's color", () => {
		const { view, screen } = createView();
		const plain = screen();
		expect(plain[0]).toMatch(/^─+$/);
		expect(plain.at(-1)).toMatch(/^─+$/);

		const rendered = view.render(120).join("\n");
		expect(rendered).not.toContain("\x1b[7m");
		const selectedRow = view.render(120).find((line) => line.includes("SQLite"));
		const [selectedOpen] = theme.bg("selectedBg", "x").split("x");
		expect(selectedRow?.startsWith(selectedOpen)).toBe(true);
	});

	it("uses the submit-all hint on the last question and drops navigation for one question", () => {
		const multi = createView();
		multi.view.handleInput("1");
		expect(multi.screen()).toContain(
			" tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt",
		);

		const single = createView([QUESTIONS[0]]);
		expect(single.screen()).toContain(" tab to add notes | enter to submit all | esc to interrupt");
	});

	it.each([80, 120])("keeps every line within %i columns and shows all options", (width) => {
		const { view, screen } = createView();
		for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(screen(width).join("\n")).toContain("None of the above");
	});

	it("selects and advances with digit keys, submitting from the last question", () => {
		const { view, done, screen } = createView();

		view.handleInput("2");
		expect(screen()).toContain(" Question 2/2 (1 unanswered)");
		expect(done).not.toHaveBeenCalled();

		view.handleInput("3");
		expect(done).toHaveBeenCalledWith([
			{ id: "storage", question: QUESTIONS[0].question, answer: "JSON file", note: undefined },
			{ id: "order", question: QUESTIONS[1].question, answer: "None of the above", note: undefined },
		]);
	});

	it("selects with arrows and Enter", () => {
		const { view, done } = createView([QUESTIONS[0]]);
		view.handleInput(DOWN);
		view.handleInput(ENTER);
		expect(done.mock.calls[0][0]?.[0].answer).toBe("JSON file");
	});

	it("returns a note typed after Tab, treating digits in the note as text", () => {
		const { view, done, screen } = createView([QUESTIONS[0]]);
		view.handleInput(TAB);
		expect(screen()).toContain(" tab or esc to clear notes | enter to submit all");
		view.handleInput("v");
		view.handleInput("2");
		view.handleInput(ENTER);
		expect(done.mock.calls[0][0]?.[0]).toMatchObject({ answer: "SQLite (Recommended)", note: "v2" });
	});

	it("clears the note with Esc instead of interrupting", () => {
		const { view, done, screen } = createView([QUESTIONS[0]]);
		view.handleInput(TAB);
		view.handleInput("x");
		view.handleInput(ESC);
		expect(done).not.toHaveBeenCalled();
		expect(screen()).toContain(" tab to add notes | enter to submit all | esc to interrupt");
		view.handleInput(ENTER);
		expect(done.mock.calls[0][0]?.[0].note).toBeUndefined();
	});

	it("returns to a skipped question before submitting", () => {
		const { view, done, screen } = createView();
		view.handleInput("\x1b[C");
		view.handleInput("1");
		expect(done).not.toHaveBeenCalled();
		expect(screen()).toContain(" Question 1/2 (1 unanswered)");
		view.handleInput(LEFT);
		view.handleInput("1");
		expect(done).not.toHaveBeenCalled();
	});

	it("interrupts with Esc", () => {
		const { view, done } = createView();
		view.handleInput(ESC);
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("formats answers by question id, with notes as user_note entries", () => {
		expect(
			JSON.parse(
				formatAnswers([
					{ id: "storage", question: "q", answer: "JSON file", note: "one file" },
					{ id: "order", question: "q", answer: "Newest created" },
				]),
			),
		).toEqual({
			answers: {
				storage: { answers: ["JSON file", "user_note: one file"] },
				order: { answers: ["Newest created"] },
			},
		});
	});
});

describe("request_user_input record", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	function renderers() {
		let tool: ToolDefinition | undefined;
		const registerTool = (definition: ToolDefinition) => {
			tool = definition;
		};
		requestUserInput({ registerTool } as never);
		return tool!;
	}

	it("shows the title while running and the answers in the result", () => {
		const tool = renderers();
		const running = tool.renderCall?.({} as never, theme, { isPartial: true } as never);
		expect(stripAnsi(running?.render(40).join("") ?? "").trim()).toBe("Questions");
		const finished = tool.renderCall?.({} as never, theme, { isPartial: false } as never);
		expect(finished?.render(40)).toEqual([]);

		const details = {
			total: 1,
			answers: [{ id: "q", question: "Which?", answer: "JSON file", note: "one file" }],
		};
		const result = tool.renderResult?.(
			{ content: [], details },
			{ expanded: false, isPartial: false },
			theme,
			{} as never,
		);
		expect((result?.render(40) ?? []).map((line) => stripAnsi(line).trimEnd())).toEqual([
			"Questions 1/1 answered",
			"  • Which?",
			"    answer: JSON file",
			"    note: one file",
		]);
	});

	it("shows the reason when nothing was answered", () => {
		const result = renderers().renderResult?.(
			{ content: [{ type: "text", text: "Interrupted by the user" }], details: { total: 1, answers: [] } },
			{ expanded: false, isPartial: false },
			theme,
			{} as never,
		);
		expect(stripAnsi(result?.render(40).join("") ?? "").trim()).toBe("Interrupted by the user");
	});
});
