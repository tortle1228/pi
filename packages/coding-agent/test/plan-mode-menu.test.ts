import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { PlanMenu, type PlanMenuChoice } from "../src/extensions/plan-mode/plan-menu.ts";
import { extractProposedPlan, renderProposedPlanMarkdown } from "../src/extensions/plan-mode/proposed-plan.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createMenu(percent: number | null | undefined = 12.4) {
	const done = vi.fn<(choice: PlanMenuChoice) => void>();
	const menu = new PlanMenu(percent, theme, new KeybindingsManager(), () => {}, done);
	return { menu, done, screen: (width = 120) => menu.render(width).map((line) => stripAnsi(line).trimEnd()) };
}

describe("proposed plan parsing", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("extracts a complete block with tags on their own lines", () => {
		const text = "Intro\n\n<proposed_plan>\n# Title\n\n- step\n</proposed_plan>\n\nOutro";
		expect(extractProposedPlan(text)).toBe("# Title\n\n- step");
	});

	it("ignores missing, unterminated, and inline blocks", () => {
		expect(extractProposedPlan("no plan")).toBeUndefined();
		expect(extractProposedPlan("<proposed_plan>\n# cut off")).toBeUndefined();
		expect(extractProposedPlan("mentions <proposed_plan> inline </proposed_plan>")).toBeUndefined();
	});

	it("ignores tags in fenced code and keeps fences inside a plan", () => {
		const example = "```\n<proposed_plan>\nplan content\n</proposed_plan>\n```";
		expect(extractProposedPlan(example)).toBeUndefined();
		expect(renderProposedPlanMarkdown(example)).toBe(example);
		expect(extractProposedPlan(`${example}\n\n<proposed_plan>\n# Real\n</proposed_plan>`)).toBe("# Real");

		const fenced = "<proposed_plan>\n# Title\n```ts\nconst a = 1;\n```\n</proposed_plan>";
		expect(extractProposedPlan(fenced)).toBe("# Title\n```ts\nconst a = 1;\n```");
		expect(stripAnsi(renderProposedPlanMarkdown(fenced))).toBe(
			"• Proposed Plan\n\n---\n\n# Title\n```ts\nconst a = 1;\n```\n\n---",
		);
		expect(renderProposedPlanMarkdown("```\n<proposed_plan>")).toBe("```\n<proposed_plan>");
	});

	it("renders the heading and hides the tags, also while streaming", () => {
		const render = (markdown: string) => stripAnsi(renderProposedPlanMarkdown(markdown));
		expect(render("<proposed_plan>\n# Title\n</proposed_plan>")).toBe("• Proposed Plan\n\n---\n\n# Title\n\n---");
		expect(render("<proposed_plan>\n# Title")).toBe("• Proposed Plan\n\n---\n\n# Title");
		expect(renderProposedPlanMarkdown("plain text")).toBe("plain text");
	});
});

describe("Implement this plan menu", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders the three options, the context usage, and the hint", () => {
		const lines = createMenu().screen();
		expect(lines[0]).toMatch(/^─+$/);
		expect(lines.at(-1)).toMatch(/^─+$/);
		expect(lines).toContain(" Implement this plan?");
		expect(lines.join("\n")).toContain(" › 1. Yes, implement this plan");
		expect(lines.join("\n")).toContain("Switch to Build and start coding");
		expect(lines.join("\n")).toContain("Start a fresh session (current context: 12% used)");
		expect(lines.join("\n")).toContain("3. No, stay in Plan mode");
		expect(lines).toContain(" enter select · esc back");
	});

	it("omits the usage when it is unknown", () => {
		expect(createMenu(null).screen().join("\n")).toMatch(/Start a fresh session$/m);
	});

	it.each([80, 120])("fits %i columns with every option visible", (width) => {
		const { menu, screen } = createMenu();
		for (const line of menu.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(screen(width).join("\n")).toContain("3. No, stay in Plan mode");
	});

	it.each<[string, PlanMenuChoice]>([
		["1", "implement"],
		["2", "implement-fresh"],
		["3", "stay"],
		["\x1b", "stay"],
	])("resolves input %j to %s", (input, choice) => {
		const { menu, done } = createMenu();
		menu.handleInput(input);
		expect(done).toHaveBeenCalledWith(choice);
	});

	it("moves with arrows and confirms with Enter", () => {
		const { menu, done } = createMenu();
		menu.handleInput("\x1b[B");
		menu.handleInput("\r");
		expect(done).toHaveBeenCalledWith("implement-fresh");
	});
});
