// Numbered option rows shared by the question view and the plan menu.
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

export interface OptionRow {
	label: string;
	description?: string;
}

// Below this width a description goes under its label instead of beside it.
const MIN_SIDE_DESCRIPTION_WIDTH = 20;
const COLUMN_GAP = 2;

/** Renders rows as `› 1. label  description`, highlighting the selected row across the full width. */
export function renderOptionRows(
	rows: readonly OptionRow[],
	selected: number,
	width: number,
	theme: Theme,
	indent = 0,
): string[] {
	const titles = rows.map((row, index) => `${index + 1}. ${row.label}`);
	const titleWidth = Math.max(...titles.map((title) => visibleWidth(title)));
	const markerWidth = indent + 2;
	const descriptionWidth = width - markerWidth - titleWidth - COLUMN_GAP;
	const sideBySide = descriptionWidth >= MIN_SIDE_DESCRIPTION_WIDTH;
	const lines: string[] = [];

	for (const [index, row] of rows.entries()) {
		const isSelected = index === selected;
		const marker = `${" ".repeat(indent)}${isSelected ? "› " : "  "}`;
		const pad = " ".repeat(markerWidth);
		const rowLines = sideBySide
			? sideBySideLines(titles[index], row.description, titleWidth, descriptionWidth)
			: stackedLines(titles[index], row.description, width - markerWidth);
		for (const [lineIndex, line] of rowLines.entries()) {
			const prefix = lineIndex === 0 ? marker : pad;
			if (isSelected) {
				const content = `${prefix}${line.title}${line.description ?? ""}`;
				const padding = " ".repeat(Math.max(0, width - visibleWidth(content)));
				const cursor = lineIndex === 0 ? theme.fg("accent", prefix) : prefix;
				const title = theme.fg("text", theme.bold(line.title));
				const description = theme.fg("text", line.description ?? "");
				lines.push(theme.bg("selectedBg", `${cursor}${title}${description}${padding}`));
			} else {
				lines.push(`${prefix}${line.title}${line.description ? theme.fg("muted", line.description) : ""}`);
			}
		}
	}
	return lines;
}

function sideBySideLines(
	title: string,
	description: string | undefined,
	titleWidth: number,
	descriptionWidth: number,
): Array<{ title: string; description?: string }> {
	const gap = " ".repeat(titleWidth - visibleWidth(title) + COLUMN_GAP);
	const wrapped = description ? wrapTextWithAnsi(description, descriptionWidth) : [];
	if (wrapped.length === 0) return [{ title }];
	const continuation = " ".repeat(titleWidth + COLUMN_GAP);
	return wrapped.map((line, index) =>
		index === 0 ? { title: `${title}${gap}`, description: line } : { title: continuation, description: line },
	);
}

function stackedLines(
	title: string,
	description: string | undefined,
	available: number,
): Array<{ title: string; description?: string }> {
	const titleLines = wrapTextWithAnsi(title, Math.max(1, available)).map((line) => ({ title: line }));
	const descriptionIndent = "   ";
	const descriptionLines = description
		? wrapTextWithAnsi(description, Math.max(1, available - descriptionIndent.length))
		: [];
	return [...titleLines, ...descriptionLines.map((line) => ({ title: descriptionIndent, description: line }))];
}
