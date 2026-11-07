// Interactive panel for request_user_input, shown in place of the editor.
import { type Component, type Focusable, Input, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { type OptionRow, renderOptionRows } from "./options.ts";

export interface Question {
	id: string;
	header: string;
	question: string;
	options: OptionRow[];
}

export interface QuestionAnswer {
	id: string;
	question: string;
	answer: string;
	note?: string;
}

interface QuestionState {
	selected: number;
	answered: boolean;
	/** Open note text. Undefined while the question has no note input. */
	note?: string;
}

const NONE_OF_THE_ABOVE: OptionRow = {
	label: "None of the above",
	description: "Optionally, add details in notes (tab)",
};
const INDENT = " ";

/** Collects one answer per question, and resolves with undefined when the user interrupts. */
export class QuestionView implements Component, Focusable {
	private readonly questions: readonly Question[];
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (answers: QuestionAnswer[] | undefined) => void;
	private readonly states: QuestionState[];
	private readonly noteInput = new Input({ prompt: "› " });
	private index = 0;
	private isFocused = false;

	constructor(
		questions: readonly Question[],
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (answers: QuestionAnswer[] | undefined) => void,
	) {
		this.questions = questions;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.states = questions.map(() => ({ selected: 0, answered: false }));
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		this.noteInput.focused = value;
	}

	invalidate(): void {
		this.noteInput.invalidate();
	}

	render(width: number): string[] {
		const state = this.states[this.index];
		const question = this.questions[this.index];
		const contentWidth = Math.max(1, width - INDENT.length);
		const unanswered = this.states.filter((candidate) => !candidate.answered).length;
		const indented = (text: string) => wrapTextWithAnsi(text, contentWidth).map((line) => `${INDENT}${line}`);

		const progress = `Question ${this.index + 1}/${this.questions.length} (${unanswered} unanswered)`;
		const lines = [
			...new DynamicBorder().render(width),
			...indented(this.theme.fg("accent", this.theme.bold(progress))),
			...indented(this.theme.fg("text", this.theme.bold(question.question))),
			"",
			...renderOptionRows(this.rows(), state.selected, width, this.theme, INDENT.length),
		];
		if (state.note !== undefined) {
			lines.push("", ...this.noteInput.render(contentWidth).map((line) => `${INDENT}${line}`));
		}
		lines.push("", ...indented(this.theme.fg("dim", this.hint(state))), ...new DynamicBorder().render(width));
		return lines;
	}

	handleInput(data: string): void {
		const state = this.states[this.index];
		if (this.keybindings.matches(data, "tui.select.up")) this.moveSelection(state, -1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.moveSelection(state, 1);
		else if (state.note !== undefined) this.handleNoteInput(data, state);
		else if (this.keybindings.matches(data, "tui.input.tab")) this.setNote(state, "");
		else if (this.keybindings.matches(data, "tui.editor.cursorLeft")) this.navigate(-1);
		else if (this.keybindings.matches(data, "tui.editor.cursorRight")) this.navigate(1);
		else if (this.keybindings.matches(data, "tui.select.confirm")) this.answer(state);
		else if (this.keybindings.matches(data, "tui.select.cancel")) this.done(undefined);
		else this.selectByDigit(data, state);
		this.tui.requestRender();
	}

	private rows(): OptionRow[] {
		return [...this.questions[this.index].options, NONE_OF_THE_ABOVE];
	}

	private hint(state: QuestionState): string {
		const isFinal =
			this.index === this.questions.length - 1 &&
			this.states.every((candidate) => candidate === state || candidate.answered);
		const submit = isFinal ? "enter to submit all" : "enter to submit answer";
		if (state.note !== undefined) return `tab or esc to clear notes | ${submit}`;
		const navigate = this.questions.length > 1 ? ["←/→ to navigate questions"] : [];
		return ["tab to add notes", submit, ...navigate, "esc to interrupt"].join(" | ");
	}

	private moveSelection(state: QuestionState, delta: number): void {
		const count = this.rows().length;
		state.selected = (state.selected + delta + count) % count;
	}

	private handleNoteInput(data: string, state: QuestionState): void {
		if (this.keybindings.matches(data, "tui.input.tab") || this.keybindings.matches(data, "tui.select.cancel")) {
			state.note = undefined;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.answer(state);
		} else {
			this.noteInput.handleInput(data);
			state.note = this.noteInput.getValue();
		}
	}

	private setNote(state: QuestionState, note: string | undefined): void {
		state.note = note;
		this.noteInput.setValue(note ?? "");
	}

	private navigate(delta: number): void {
		const count = this.questions.length;
		this.index = (this.index + delta + count) % count;
		this.setNote(this.states[this.index], this.states[this.index].note);
	}

	private selectByDigit(data: string, state: QuestionState): void {
		const option = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
		if (option < 0 || option >= this.rows().length) return;
		state.selected = option;
		this.answer(state);
	}

	/** Records the current question, then moves on: forward, then to any skipped question, then submits. */
	private answer(state: QuestionState): void {
		state.answered = true;
		const next =
			this.index < this.questions.length - 1
				? this.index + 1
				: this.states.findIndex((candidate) => !candidate.answered);
		if (next === -1) {
			this.done(this.collect());
			return;
		}
		this.index = next;
		this.setNote(this.states[next], this.states[next].note);
	}

	private collect(): QuestionAnswer[] {
		return this.questions.map((question, index) => {
			const state = this.states[index];
			const rows = [...question.options, NONE_OF_THE_ABOVE];
			const note = state.note?.trim();
			return {
				id: question.id,
				question: question.question,
				answer: rows[state.selected].label,
				note: note || undefined,
			};
		});
	}
}
