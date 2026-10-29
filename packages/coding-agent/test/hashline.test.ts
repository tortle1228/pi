import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	formatTaggedLines,
	HashlineMismatchError,
	hashLine,
	lineTag,
} from "../src/core/tools/hashline.ts";

const FILE = "alpha\nbeta\ngamma\ndelta\n";
const tag = (lineNumber: number) => lineTag(lineNumber, FILE.split("\n")[lineNumber - 1]);

describe("hashLine", () => {
	it("returns two letters that depend on the content, ignoring a trailing CR", () => {
		expect(hashLine("const a = 1;")).toMatch(/^[bcdfghjkmnpqrstv]{2}$/);
		expect(hashLine("const a = 1;")).toBe(hashLine("const a = 1;\r"));
		const distinct = new Set(Array.from({ length: 64 }, (_, index) => hashLine(`line ${index}`)));
		expect(distinct.size).toBeGreaterThan(40);
	});

	it("formats lines as TAG|text from the given first line", () => {
		expect(formatTaggedLines(["a", "b"], 7)).toBe(`${lineTag(7, "a")}|a\n${lineTag(8, "b")}|b`);
	});
});

describe("applyHashlineEdits", () => {
	it("replaces a line and a range, and keeps the final newline", () => {
		const { content } = applyHashlineEdits(FILE, [
			{ start: tag(1), newText: "ALPHA" },
			{ start: tag(3), end: tag(4), newText: "GAMMA+DELTA\n" },
		]);
		expect(content).toBe("ALPHA\nbeta\nGAMMA+DELTA\n");
	});

	it("inserts before and after a line, in the order given at one gap", () => {
		const { content } = applyHashlineEdits(FILE, [
			{ start: tag(2), insert: "after", newText: "after-1" },
			{ start: tag(3), insert: "before", newText: "before-1\nbefore-2" },
			{ start: tag(1), insert: "before", newText: "top" },
		]);
		expect(content).toBe("top\nalpha\nbeta\nafter-1\nbefore-1\nbefore-2\ngamma\ndelta\n");
	});

	it("deletes lines with empty newText, down to an empty file", () => {
		expect(applyHashlineEdits(FILE, [{ start: tag(2), newText: "" }]).content).toBe("alpha\ngamma\ndelta\n");
		expect(applyHashlineEdits(FILE, [{ start: tag(1), end: tag(4), newText: "" }]).content).toBe("");
	});

	it("returns the changed lines with fresh tags and one line of context", () => {
		const { content, changedLines } = applyHashlineEdits(FILE, [{ start: tag(2), newText: "BETA\nBETA2" }]);
		const lines = content.split("\n");
		expect(changedLines).toBe(formatTaggedLines(lines.slice(0, 4), 1));
		expect(applyHashlineEdits(content, [{ start: lineTag(3, "BETA2"), newText: "b2" }]).content).toBe(
			"alpha\nBETA\nb2\ngamma\ndelta\n",
		);
	});

	it("rejects stale tags and shows the current lines with fresh tags", () => {
		const changed = FILE.replace("beta", "BETA");
		let error: unknown;
		try {
			applyHashlineEdits(changed, [{ start: tag(2), newText: "x" }]);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(HashlineMismatchError);
		expect((error as Error).message).toContain(`${lineTag(2, "BETA")}|BETA`);
	});

	it.each([
		[[{ start: "2", newText: "x" }], 'Invalid line tag "2"'],
		[[{ start: "9#bb", newText: "x" }], "outside the file, which has 4 lines"],
		[[{ start: tag(3), end: tag(2), newText: "x" }], "comes before start"],
		[[{ start: tag(2), end: tag(3), insert: "after" as const, newText: "x" }], "insert takes only start"],
		[
			[
				{ start: tag(1), end: tag(2), newText: "x" },
				{ start: tag(2), newText: "y" },
			],
			"Edits 1 and 2 replace overlapping lines",
		],
		[
			[
				{ start: tag(1), end: tag(3), newText: "x" },
				{ start: tag(1), insert: "after" as const, newText: "y" },
			],
			"Edit 2 inserts inside lines that edit 1 replaces",
		],
	])("rejects invalid edits: %j", (edits, message) => {
		expect(() => applyHashlineEdits(FILE, edits)).toThrow(message);
	});
});
