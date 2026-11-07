// The <proposed_plan> block plan-mode responses end with.
import { theme } from "../../modes/interactive/theme/theme.ts";

const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";

// Matches fenced code as a whole, so an example tag in a fence is skipped and a fence in a plan stays intact.
// An unclosed fence runs to the end of the text, which is how it renders while streaming.
const FENCE_OR_TAG = /^(`{3,}|~{3,})[^\n]*\n?[\s\S]*?(?:^\1[`~]*[ \t]*$|(?![\s\S]))|^<\/?proposed_plan>[ \t]*$/gm;

/** The plan text of the first complete block, with its tags on their own lines outside fenced code. */
export function extractProposedPlan(text: string): string | undefined {
	let start: number | undefined;
	for (const match of text.matchAll(FENCE_OR_TAG)) {
		if (match[0].startsWith(OPEN_TAG)) start ??= match.index + match[0].length;
		else if (match[0].startsWith(CLOSE_TAG) && start !== undefined) return text.slice(start, match.index).trim();
	}
	return undefined;
}

/** Shows the block under a heading. Also handles a block still streaming, whose closing tag has not arrived. */
export function renderProposedPlanMarkdown(markdown: string): string {
	return markdown.replace(FENCE_OR_TAG, (match) => {
		if (match.startsWith(OPEN_TAG)) return `${theme.fg("accent", theme.bold("• Proposed Plan"))}\n\n---\n`;
		return match.startsWith(CLOSE_TAG) ? "\n---" : match;
	});
}
