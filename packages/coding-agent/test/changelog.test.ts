import { describe, expect, test } from "vitest";
import { type ChangelogEntry, getNewEntries } from "../src/utils/changelog.ts";

describe("getNewEntries", () => {
	const entries: ChangelogEntry[] = [
		{ major: 0, minor: 1, patch: 5, content: "0.1.5" },
		{ major: 0, minor: 1, patch: 4, content: "0.1.4" },
	];
	const newContent = (lastVersion: string) => getNewEntries(entries, lastVersion)?.map((e) => e.content);

	// #11703
	test("ignores prerelease and build suffixes of the last seen version", () => {
		expect(newContent("0.1.5-20261020.7")).toEqual([]);
		expect(newContent("0.1.5+build.3")).toEqual([]);
		expect(newContent("0.1.4-beta.1")).toEqual(["0.1.5"]);
	});

	test("compares release versions numerically", () => {
		expect(newContent("0.1.5")).toEqual([]);
		expect(newContent("0.1.3")).toEqual(["0.1.5", "0.1.4"]);
		expect(getNewEntries([{ major: 0, minor: 10, patch: 0, content: "0.10.0" }], "0.9.0")?.length).toBe(1);
	});

	test("returns undefined for a last seen version without major.minor.patch", () => {
		expect(newContent("latest")).toBeUndefined();
		expect(newContent("0.1")).toBeUndefined();
		expect(newContent("")).toBeUndefined();
	});
});
