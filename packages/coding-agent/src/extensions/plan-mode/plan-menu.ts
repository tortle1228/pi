// The "Implement this plan?" menu shown in place of the editor after a proposed plan.
import type { Component } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { renderOptionRows } from "../request-user-input/options.ts";

export type PlanMenuChoice = "implement" | "implement-fresh" | "stay";

const CHOICES: readonly PlanMenuChoice[] = ["implement", "implement-fresh", "stay"];

/** The context share for the fresh-session option. Omitted when usage is unknown, as right after compaction. */
function freshSessionDescription(contextPercent: number | null | undefined): string {
	if (contextPercent === null || contextPercent === undefined) return "Start a fresh session";
	return `Start a fresh session (current context: ${Math.round(contextPercent)}% used)`;
}

/** Resolves with the chosen action. Esc stays in Plan mode, like the third option. */
export class PlanMenu implements Component {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (choice: PlanMenuChoice) => void;
	private readonly requestRender: () => void;
	private readonly contextPercent: number | null | undefined;
	private selected = 0;

	constructor(
		contextPercent: number | null | undefined,
		theme: Theme,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		done: (choice: PlanMenuChoice) => void,
	) {
		this.contextPercent = contextPercent;
		this.theme = theme;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rows = [
			{ label: "Yes, implement this plan", description: "Switch to Build and start coding" },
			{ label: "Yes, clear context and implement", description: freshSessionDescription(this.contextPercent) },
			{ label: "No, stay in Plan mode", description: "Continue planning with the model" },
		];
		return [
			...new DynamicBorder().render(width),
			` ${this.theme.fg("accent", this.theme.bold("Implement this plan?"))}`,
			"",
			...renderOptionRows(rows, this.selected, width, this.theme, 1),
			"",
			` ${this.theme.fg("dim", "enter select · esc back")}`,
			...new DynamicBorder().render(width),
		];
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selected = (this.selected - 1 + CHOICES.length) % CHOICES.length;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.selected = (this.selected + 1) % CHOICES.length;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done(CHOICES[this.selected]);
			return;
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done("stay");
			return;
		} else if (/^[1-3]$/.test(data)) {
			this.done(CHOICES[Number(data) - 1]);
			return;
		}
		this.requestRender();
	}
}
