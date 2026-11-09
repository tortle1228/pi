import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	normalizeLine,
	observerPrompt,
	parseObservation,
	skipsAfterIgnores,
} from "../src/extensions/you-should-know/prompt.ts";
import { type OfferAction, OfferWidget } from "../src/extensions/you-should-know/widget.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

describe("you-should-know parser", () => {
	it("reads none", () => {
		expect(parseObservation("learn: none")).toEqual({ kind: "none" });
		expect(parseObservation("**Learn:** None.")).toEqual({ kind: "none" });
	});

	it("reads an offer with its explanation", () => {
		const text = [
			"learn: The cache key ignores the locale, so users may see another language.  ",
			"tag: Heads up  ",
			"explain:",
			"**Cache ignores locale**",
			"* Pages are cached by URL only.",
		].join("\n");
		expect(parseObservation(text)).toEqual({
			kind: "offer",
			line: "The cache key ignores the locale, so users may see another language.",
			tag: "Heads up",
			explanation: "**Cache ignores locale**\n* Pages are cached by URL only.",
		});
	});

	it("defaults the tag and accepts decorated labels", () => {
		expect(parseObservation("**learn:** Retries double the bill.\n*tag*: whatever\nexplain: short")).toEqual({
			kind: "offer",
			line: "Retries double the bill.",
			tag: "You should know",
			explanation: "short",
		});
	});

	it("rejects output without a learn line", () => {
		expect(parseObservation("I think nothing stands out.")).toEqual({ kind: "invalid" });
		expect(parseObservation("learn:\ntag: Heads up")).toEqual({ kind: "invalid" });
	});

	it("lists seen lines in the prompt", () => {
		expect(observerPrompt([])).not.toContain("Already shown");
		expect(observerPrompt(["Old note"])).toContain("- Old note");
	});

	it("backs off after repeated ignores", () => {
		expect([1, 2, 3, 4, 5, 7, 8, 20].map(skipsAfterIgnores)).toEqual([0, 0, 1, 2, 4, 16, 16, 16]);
	});

	it("normalizes lines for dedup", () => {
		expect(normalizeLine(" Retries Double the bill. ")).toBe(normalizeLine("retries double the bill"));
	});
});

describe("you-should-know widget", () => {
	function click(widget: OfferWidget, x: number, y: number) {
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width: 80,
			height: 10,
			shift: false,
			alt: false,
			ctrl: false,
		};
		return widget.handleMouse(event);
	}

	it("maps clicks on the button row to actions", () => {
		const actions: OfferAction[] = [];
		const view = { line: "Retries double the bill.", tag: "Heads up" as const, explanation: "* a", expanded: false };
		const widget = new OfferWidget(view, theme, (action) => actions.push(action));
		const lines = widget.render(80);
		expect(lines.join("\n")).toContain("Retries double the bill.");
		const row = lines.length - 1;
		// "  [Explain]  [Chat in main session]  [Dismiss]"
		expect(click(widget, 2, row)).toEqual({ handled: true });
		expect(click(widget, 13, row)).toEqual({ handled: true });
		expect(click(widget, 37, row)).toEqual({ handled: true });
		expect(click(widget, 11, row)).toBeUndefined();
		expect(click(widget, 2, 0)).toBeUndefined();
		expect(actions).toEqual(["explain", "chat", "dismiss"]);
	});

	it("shows the explanation and drops Explain once expanded", () => {
		const actions: OfferAction[] = [];
		const view = { line: "Line", tag: "You should know" as const, explanation: "explanation-marker", expanded: true };
		const widget = new OfferWidget(view, theme, (action) => actions.push(action));
		const lines = widget.render(80);
		expect(lines.join("\n")).toContain("explanation-marker");
		click(widget, 2, lines.length - 1);
		expect(actions).toEqual(["chat"]);
	});
});
