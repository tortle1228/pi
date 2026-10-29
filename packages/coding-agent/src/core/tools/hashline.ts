/**
 * Hashline addressing: `read` and `grep` tag every line they show as `12#kq`, the line number and a two-letter hash of
 * its content, and the hashline `edit` refers to lines by those tags instead of repeating their text. A tag whose
 * hash no longer matches the line shows the file changed since it was read, so the edit is rejected before it
 * changes the wrong lines.
 */

/** Letters for the hash, chosen to be unlike digits and each other. 16 letters, so two of them hold one byte. */
const HASH_ALPHABET = "bcdfghjkmnpqrstv";
const TAG_PATTERN = /^(\d+)#([bcdfghjkmnpqrstv]{2})$/;
/** Lines around a stale line that a mismatch error shows with fresh tags. */
const MISMATCH_CONTEXT_LINES = 2;

/** The two-letter hash of one line, without its line ending. */
export function hashLine(text: string): string {
	// FNV-1a over UTF-16 code units: fast, and spreads small edits such as one changed character well.
	let hash = 0x811c9dc5;
	const line = text.endsWith("\r") ? text.slice(0, -1) : text;
	for (let index = 0; index < line.length; index++) {
		hash ^= line.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	const byte = (hash ^ (hash >>> 8) ^ (hash >>> 16) ^ (hash >>> 24)) & 0xff;
	return HASH_ALPHABET[byte >> 4] + HASH_ALPHABET[byte & 0xf];
}

/** The tag of a line, such as `12#kq`. */
export function lineTag(lineNumber: number, text: string): string {
	return `${lineNumber}#${hashLine(text)}`;
}

/** `lines` as `read` shows them in hashline mode: `12#kq|text`, numbered from `firstLineNumber`. */
export function formatTaggedLines(lines: readonly string[], firstLineNumber: number): string {
	return lines.map((line, index) => `${lineTag(firstLineNumber + index, line)}|${line}`).join("\n");
}

/** One hashline edit, as the `edit` tool receives it. */
export interface HashlineEdit {
	/** Tag of the first line to replace, or of the line to insert next to. */
	start: string;
	/** Tag of the last line to replace. Default: `start`. Not allowed with `insert`. */
	end?: string;
	/** Insert `newText` before or after the `start` line instead of replacing lines. */
	insert?: "before" | "after";
	/** The new lines. Empty deletes the lines. A final line end is optional. */
	newText: string;
}

/** A tag that no longer matches the file. */
export class HashlineMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HashlineMismatchError";
	}
}

export interface HashlineResult {
	/** The new content, with LF line ends. */
	content: string;
	/** The changed lines of the new content, tagged, with one line of context around each change. */
	changedLines: string;
}

interface ResolvedEdit {
	/** 0-based index of the first line replaced, or of the gap where lines are inserted. */
	from: number;
	/** Number of lines replaced; 0 for an insertion. */
	count: number;
	lines: string[];
	/** Order of the edit in the call, to keep insertions at one gap in the order given. */
	order: number;
}

/**
 * Applies `edits` to `content` (LF line ends). Every tag refers to `content` as given, not to the result of earlier
 * edits in the same call. Throws `HashlineMismatchError` when a tag is stale, and `Error` for invalid edits.
 */
export function applyHashlineEdits(content: string, edits: readonly HashlineEdit[]): HashlineResult {
	const endsWithNewline = content.endsWith("\n");
	const lines = content.split("\n");
	if (endsWithNewline) lines.pop();

	const stale: number[] = [];
	const resolveTag = (tag: string): number => {
		const match = TAG_PATTERN.exec(tag.trim());
		if (!match) throw new Error(`Invalid line tag "${tag}". Use a tag from read or grep, such as "12#kq".`);
		const index = Number(match[1]) - 1;
		if (index < 0 || index >= lines.length) {
			throw new Error(`Line tag "${tag}" is outside the file, which has ${lines.length} lines.`);
		}
		if (hashLine(lines[index]) !== match[2]) stale.push(index);
		return index;
	};

	const resolved: ResolvedEdit[] = edits.map((edit, order) => {
		const start = resolveTag(edit.start);
		const newLines = splitNewText(edit.newText);
		if (edit.insert) {
			if (edit.end !== undefined) throw new Error(`Edit ${order + 1}: insert takes only start, not end.`);
			return { from: edit.insert === "before" ? start : start + 1, count: 0, lines: newLines, order };
		}
		const end = edit.end === undefined ? start : resolveTag(edit.end);
		if (end < start) throw new Error(`Edit ${order + 1}: end ${edit.end} comes before start ${edit.start}.`);
		return { from: start, count: end - start + 1, lines: newLines, order };
	});
	if (stale.length > 0) throw new HashlineMismatchError(describeStale(lines, stale));
	checkOverlaps(resolved);

	// Bottom-up, so earlier positions stay valid; at one gap, later edits go below earlier ones.
	const ordered = [...resolved].sort((a, b) => b.from - a.from || b.order - a.order);
	const next = [...lines];
	for (const edit of ordered) next.splice(edit.from, edit.count, ...edit.lines);

	return {
		content: next.length === 0 ? "" : next.join("\n") + (endsWithNewline ? "\n" : ""),
		changedLines: describeChanges(next, resolved),
	};
}

function splitNewText(text: string): string[] {
	if (text === "") return [];
	const normalized = text.replace(/\r\n/g, "\n");
	return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}

function checkOverlaps(edits: readonly ResolvedEdit[]): void {
	const replacements = edits.filter((edit) => edit.count > 0).sort((a, b) => a.from - b.from);
	for (let index = 1; index < replacements.length; index++) {
		const previous = replacements[index - 1];
		if (replacements[index].from < previous.from + previous.count) {
			throw new Error(
				`Edits ${previous.order + 1} and ${replacements[index].order + 1} replace overlapping lines. Merge them into one edit.`,
			);
		}
	}
	for (const insertion of edits.filter((edit) => edit.count === 0)) {
		const inside = replacements.find((edit) => insertion.from > edit.from && insertion.from < edit.from + edit.count);
		if (inside) {
			throw new Error(
				`Edit ${insertion.order + 1} inserts inside lines that edit ${inside.order + 1} replaces. Merge them into one edit.`,
			);
		}
	}
}

function describeStale(lines: readonly string[], stale: readonly number[]): string {
	const shown = new Set<number>();
	for (const index of stale) {
		for (let near = index - MISMATCH_CONTEXT_LINES; near <= index + MISMATCH_CONTEXT_LINES; near++) {
			if (near >= 0 && near < lines.length) shown.add(near);
		}
	}
	const current = [...shown]
		.sort((a, b) => a - b)
		.map((index) => `${lineTag(index + 1, lines[index])}|${lines[index]}`);
	const which = stale.map((index) => index + 1).join(", ");
	return `Line${stale.length > 1 ? "s" : ""} ${which} changed since ${stale.length > 1 ? "they were" : "it was"} read, so nothing was edited. Current lines:\n${current.join("\n")}\nUse these tags, or read the file again.`;
}

/** The new lines of each edit with one line of context, tagged, so the next edit needs no new read. */
function describeChanges(lines: readonly string[], edits: readonly ResolvedEdit[]): string {
	// Positions in the new content: each edit moves the ones below it by its size change.
	const ranges = [...edits]
		.sort((a, b) => a.from - b.from || a.order - b.order)
		.reduce<{ shift: number; ranges: Array<[number, number]> }>(
			(state, edit) => {
				const from = edit.from + state.shift;
				state.ranges.push([from - 1, from + edit.lines.length]);
				state.shift += edit.lines.length - edit.count;
				return state;
			},
			{ shift: 0, ranges: [] },
		).ranges;
	const shown = new Set<number>();
	for (const [from, to] of ranges) {
		for (let index = Math.max(0, from); index <= Math.min(lines.length - 1, to); index++) shown.add(index);
	}
	const sorted = [...shown].sort((a, b) => a - b);
	const out: string[] = [];
	sorted.forEach((index, position) => {
		if (position > 0 && index !== sorted[position - 1] + 1) out.push("...");
		out.push(`${lineTag(index + 1, lines[index])}|${lines[index]}`);
	});
	return out.join("\n");
}
