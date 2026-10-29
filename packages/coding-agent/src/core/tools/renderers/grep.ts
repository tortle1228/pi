/**
 * Presentation for the grep tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `grep.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { GrepToolDetails } from "../grep.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

/** Renders a string or a list of strings as one comma-separated string; null for anything else. */
function strList(value: unknown): string | null {
	if (Array.isArray(value)) return value.every((item) => typeof item === "string") ? value.join(", ") : null;
	return str(value);
}

function formatGrepCall(
	args:
		| {
				pattern: string;
				path?: string | string[];
				glob?: string | string[];
				mode?: string;
				limit?: number;
				skip?: number;
		  }
		| undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPaths: unknown[] = Array.isArray(args?.path) && args.path.length > 0 ? args.path : [args?.path];
	const paths = rawPaths.map(str);
	const path = paths.includes(null) ? null : paths.map((item) => shortenPath(item || ".")).join(", ");
	const glob = strList(args?.glob);
	const mode = str(args?.mode);
	const limit = args?.limit;
	const skip = args?.skip;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (mode && mode !== "content") text += theme.fg("toolOutput", ` ${mode}`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	if (skip) text += theme.fg("toolOutput", ` skip ${skip}`);
	return text;
}
function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const fileLimit = result.details?.fileLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || fileLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (fileLimit) warnings.push(`${fileLimit} files limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const grepRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatGrepCall(args as any, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatGrepResult(result as any, options, theme, context.showImages));
		return text;
	},
};
