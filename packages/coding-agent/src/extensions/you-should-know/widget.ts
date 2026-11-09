import {
	type Component,
	Markdown,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { OfferTag } from "./prompt.ts";

export type OfferAction = "explain" | "chat" | "dismiss";

export interface OfferView {
	line: string;
	tag: OfferTag;
	explanation: string;
	expanded: boolean;
}

const LABELS: Record<OfferAction, string> = { explain: "Explain", chat: "Chat in main session", dismiss: "Dismiss" };

/** The note above the editor. Buttons take left clicks in fullscreen mode; `/you-should-know <action>` is the keyboard path. */
export class OfferWidget implements Component {
	private readonly view: OfferView;
	private readonly theme: Theme;
	private readonly onAction: (action: OfferAction) => void;
	private readonly markdown: Markdown | undefined;
	private buttonRow = -1;
	private buttons: { action: OfferAction; start: number; end: number }[] = [];

	constructor(view: OfferView, theme: Theme, onAction: (action: OfferAction) => void) {
		this.view = view;
		this.theme = theme;
		this.onAction = onAction;
		// The TUI keeps this instance and renders it on every redraw, so parse the explanation once.
		this.markdown =
			view.expanded && view.explanation ? new Markdown(view.explanation, 2, 0, getMarkdownTheme()) : undefined;
	}

	render(width: number): string[] {
		const tag = this.theme.fg(
			this.view.tag === "Heads up" ? "warning" : "accent",
			this.theme.bold(`● ${this.view.tag}`),
		);
		const lines = wrapTextWithAnsi(`${tag}  ${this.view.line}`, width);
		if (this.markdown) lines.push(...this.markdown.render(width));
		const actions: OfferAction[] =
			this.view.expanded || !this.view.explanation ? ["chat", "dismiss"] : ["explain", "chat", "dismiss"];
		this.buttons = [];
		let row = "";
		let x = 2;
		for (const action of actions) {
			const label = `[${LABELS[action]}]`;
			this.buttons.push({ action, start: x, end: x + label.length });
			row += `${row ? "  " : ""}${this.theme.fg("accent", label)}`;
			x += label.length + 2;
		}
		this.buttonRow = lines.length;
		lines.push(
			truncateToWidth(`  ${row}${this.theme.fg("dim", "  /you-should-know <explain|chat|dismiss>")}`, width),
		);
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== this.buttonRow) return undefined;
		const button = this.buttons.find((candidate) => event.x >= candidate.start && event.x < candidate.end);
		if (!button) return undefined;
		this.onAction(button.action);
		return { handled: true };
	}

	invalidate(): void {}
}
