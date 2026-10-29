import * as disk from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSession, type SessionSearchSource, searchSessions } from "../src/extensions/session-search/search.ts";

vi.mock("node:fs/promises", { spy: true });

const timestamp = "2026-10-01T00:00:00.000Z";
function message(id: string, parentId: string | null, text: string, role = "user", time = timestamp) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: time,
		message: { role, content: text, timestamp: Date.parse(time) },
	};
}
function edit(id: string, parentId: string, targetId: string, content: string | null) {
	return {
		type: "context_edit",
		id,
		parentId,
		targetId,
		replacement: content === null ? null : { content },
		timestamp,
	};
}

describe("read-only session retrieval", () => {
	let root: string;
	let source: SessionSearchSource;
	async function session(
		id: string,
		entries: unknown[],
		cwd = source.cwd,
		directory = source.sessionDir,
		version = 3,
	) {
		await mkdir(directory, { recursive: true });
		const file = join(directory, `${id}.jsonl`);
		await writeFile(
			file,
			[{ type: "session", id, cwd, version, timestamp }, ...entries]
				.map((value) => JSON.stringify(value))
				.join("\n"),
		);
		return file;
	}
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-session-search-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		source = { cwd: join(root, "project"), sessionDir: join(root, "custom-sessions"), currentSessionId: "current" };
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	it("matches case-insensitive literal terms and quoted phrases within one message", async () => {
		await session("one", [
			message("a", null, "AbortSignal task cancel"),
			message("b", "a", "task_cancel"),
			message("c", "b", "신호 취소"),
		]);
		expect(
			(await searchSessions({ query: 'abortsignal "task cancel"' }, source)).matches.map((m) => m.entryId),
		).toEqual(["a"]);
		expect((await searchSessions({ query: '"task cancel"' }, source)).matches.map((m) => m.entryId)).toEqual(["a"]);
		expect((await searchSessions({ query: "신호 취소" }, source)).matches.map((m) => m.entryId)).toEqual(["c"]);
		expect((await searchSessions({ query: "AbortSignal task_cancel" }, source)).matches).toEqual([]);
		expect((await searchSessions({ query: "task.*" }, source)).matches).toEqual([]);
	});

	it("filters cwd, current session, role, and inclusive message timestamps", async () => {
		await session("one", [
			message("a", null, "sentinel", "assistant"),
			message("b", "a", "sentinel", "user", "2026-10-02T00:00:00.000Z"),
		]);
		await session("current", [message("c", null, "sentinel")]);
		await session("other", [message("d", null, "sentinel")], join(root, "other"));
		const result = await searchSessions(
			{ query: "sentinel", role: "user", after: "2026-10-02", before: "2026-10-02" },
			source,
		);
		expect(result.matches.map((m) => m.entryId)).toEqual(["b"]);
		expect((await searchSessions({ query: "sentinel", includeCurrent: true }, source)).matches).toHaveLength(3);
		expect(
			(await searchSessions({ query: "sentinel", cwd: join(root, "other") }, source)).matches.map((m) => m.entryId),
		).toEqual(["d"]);
	});

	it("discovers an explicitly requested project in default storage without creating directories", async () => {
		const cwd = join(root, "second-worktree");
		const directory = join(root, "agent", "sessions", "encoded-project");
		await session("other", [message("a", null, "sentinel")], cwd, directory);
		expect((await searchSessions({ query: "sentinel" }, source)).matches).toEqual([]);
		expect((await searchSessions({ query: "sentinel", cwd }, source)).matches.map((m) => m.sessionId)).toEqual([
			"other",
		]);
	});

	it("keeps sibling branches separate when expanding a shared ancestor", async () => {
		await session("tree", [message("a", null, "root"), message("b", "a", "left"), message("c", "a", "right")]);
		const hits = (await searchSessions({ query: "root" }, source)).matches;
		expect(hits.map((m) => m.leafId)).toEqual(["b", "c"]);
		const left = await readSession({ sessionId: "tree", entryId: "a", leafId: "b" }, source);
		expect(left.entries.map((e) => e.entryId)).toEqual(["a", "b"]);
		const right = await readSession({ sessionId: "tree", entryId: "a", leafId: "c" }, source);
		expect(right.entries.map((e) => e.entryId)).toEqual(["a", "c"]);
		await expect(readSession({ sessionId: "tree", entryId: "b", leafId: "c" }, source)).rejects.toThrow();
	});

	it("applies latest context edits per branch and exposes originals only explicitly", async () => {
		await session("edits", [
			message("a", null, "original-token"),
			edit("b", "a", "a", "replacement-token"),
			edit("c", "b", "a", null),
			message("d", "a", "sibling"),
		]);
		const originals = await searchSessions({ query: "original-token" }, source);
		expect(originals.matches.map((m) => m.leafId)).toEqual(["d"]);
		expect((await searchSessions({ query: "replacement-token" }, source)).matches).toEqual([]);
		const explicit = await searchSessions({ query: "original-token", includeOriginal: true }, source);
		expect(explicit.matches.map((m) => [m.leafId, m.edit, m.view])).toEqual([
			["c", "omitted", "original"],
			["d", "unchanged", "original"],
		]);
		await expect(readSession({ sessionId: "edits", entryId: "a", leafId: "c" }, source)).rejects.toThrow();
		expect(
			(await readSession({ sessionId: "edits", entryId: "a", leafId: "c", includeOriginal: true }, source))
				.entries[0].text,
		).toBe("original-token");
	});

	it("searches replacement text instead of the original", async () => {
		await session("edit", [message("a", null, "old-token", "assistant"), edit("b", "a", "a", "new-token")]);
		expect((await searchSessions({ query: "old-token" }, source)).matches).toEqual([]);
		const hit = (await searchSessions({ query: "new-token" }, source)).matches[0];
		expect(hit).toMatchObject({ entryId: "a", edit: "replaced", view: "effective", excerpt: "new-token" });
		expect((await readSession({ sessionId: "edit", entryId: "a", leafId: "b" }, source)).entries[0].text).toBe(
			"new-token",
		);
	});

	it("keeps pre-compaction history searchable and labels it separately from summaries", async () => {
		await session("compact", [
			message("a", null, "historical-token"),
			edit("e", "a", "a", "edited-token"),
			{
				type: "compaction",
				id: "b",
				parentId: "e",
				timestamp,
				firstKeptEntryId: "b",
				summary: "summary-token",
				tokensBefore: 100,
			},
			message("c", "b", "retained-token"),
		]);
		expect((await searchSessions({ query: "historical-token" }, source)).matches).toEqual([]);
		expect((await searchSessions({ query: "edited-token" }, source)).matches[0]).toMatchObject({
			context: "summarized",
			kind: "message",
			edit: "replaced",
		});
		expect((await searchSessions({ query: "summary-token", role: "summary" }, source)).matches[0]).toMatchObject({
			kind: "compaction",
			context: "retained",
		});
		expect((await searchSessions({ query: "retained-token" }, source)).matches[0].context).toBe("retained");
	});

	it("does not expose thinking, tool output, custom data, or system prompts", async () => {
		await session("private", [
			{
				...message("a", null, "unused", "assistant"),
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hidden-token" },
						{ type: "text", text: "visible-token" },
					],
				},
			},
			message("b", "a", "hidden-token", "toolResult"),
			message("c", "b", "hidden-token", "system"),
			{ type: "custom", id: "d", parentId: "c", timestamp, customType: "state", data: "hidden-token" },
		]);
		expect((await searchSessions({ query: "hidden-token" }, source)).matches).toEqual([]);
		expect((await searchSessions({ query: "visible-token" }, source)).matches).toHaveLength(1);
	});

	it("bounds matches and excerpts with explicit truncation", async () => {
		await session("large", [
			message("a", null, `${"x".repeat(1000)} sentinel ${"y".repeat(1000)}`),
			message("b", "a", "sentinel", "user", "2026-10-02T00:00:00.000Z"),
		]);
		const result = await searchSessions({ query: "sentinel", limit: 1 }, source);
		expect(result).toMatchObject({ totalMatches: 2, truncated: true });
		expect(result.matches.map((m) => m.entryId)).toEqual(["b"]);
		const older = await searchSessions({ query: "sentinel", before: timestamp }, source);
		expect(older.matches[0].excerpt).toContain("sentinel");
		expect(older.matches[0].excerpt.length).toBeLessThanOrEqual(400);
		expect(older.matches[0].excerptTruncated).toBe(true);
		expect(older.matches[0]).not.toHaveProperty("text");
	});

	it("prioritizes the target within the read budget and reports window boundaries", async () => {
		await session("window", [
			message("a", null, "a".repeat(100)),
			message("b", "a", "target-token"),
			message("c", "b", "c".repeat(100)),
		]);
		const result = await readSession({ sessionId: "window", entryId: "b", leafId: "c", maxChars: 15 }, source);
		expect(result.entries.find((e) => e.entryId === "b")?.text).toBe("target-token");
		expect(result.entries.reduce((sum, entry) => sum + entry.text.length, 0)).toBe(15);
		expect(result.truncated).toBe(true);
		const targetOnly = await readSession(
			{ sessionId: "window", entryId: "b", leafId: "c", before: 0, after: 0 },
			source,
		);
		expect(targetOnly).toMatchObject({ hasEarlier: true, hasLater: true, truncated: false });
	});

	it("reports malformed, cyclic, legacy, and incomplete files without silently returning a complete search", async () => {
		await session("good", [message("a", null, "sentinel")]);
		await session("cycle", [message("a", "a", "sentinel")]);
		await session("legacy", [message("a", null, "sentinel")], source.cwd, source.sessionDir, 1);
		await writeFile(join(source.sessionDir, "broken.jsonl"), "{broken");
		const result = await searchSessions({ query: "sentinel" }, source);
		expect(result.matches.map((m) => m.sessionId)).toEqual(["good"]);
		expect(result).toMatchObject({ incomplete: true, warningCount: 3, scannedSessions: 1 });
		expect(result.warnings).toHaveLength(3);
	});

	it("does not repair a missing trailing newline or migrate version 2 files", async () => {
		const file = await session("readonly", [message("a", null, "sentinel")], source.cwd, source.sessionDir, 2);
		const bytes = await readFile(file);
		const initial = await stat(file);
		expect((await searchSessions({ query: "sentinel" }, source)).matches).toHaveLength(1);
		await readSession({ sessionId: "readonly", entryId: "a", leafId: "a" }, source);
		expect(await readFile(file)).toEqual(bytes);
		expect((await stat(file)).mtimeMs).toBe(initial.mtimeMs);
	});

	it("reports a file changed during a read without relying on timing", async () => {
		const file = await session("racing", [message("a", null, "sentinel")]);
		const initial = await stat(file);
		const changed = await stat(file);
		changed.size++;
		vi.mocked(disk.stat).mockResolvedValueOnce(initial).mockResolvedValueOnce(changed);
		const result = await searchSessions({ query: "sentinel" }, source);
		expect(result).toMatchObject({ matches: [], incomplete: true, warningCount: 1 });
	});

	it("bounds warnings and treats an empty storage directory as a complete search", async () => {
		expect(await searchSessions({ query: "sentinel" }, source)).toMatchObject({ matches: [], incomplete: false });
		await mkdir(source.sessionDir);
		await Promise.all(
			Array.from({ length: 12 }, (_, index) => writeFile(join(source.sessionDir, `${index}.jsonl`), "{broken")),
		);
		const result = await searchSessions({ query: "sentinel" }, source);
		expect(result.warningCount).toBe(12);
		expect(result.warnings).toHaveLength(10);
	});

	it("rejects stale leaves after a deterministic append", async () => {
		const file = await session("changed", [message("a", null, "sentinel")]);
		const hit = (await searchSessions({ query: "sentinel" }, source)).matches[0];
		await writeFile(file, `${await readFile(file, "utf8")}\n${JSON.stringify(message("b", "a", "next"))}`);
		await expect(
			readSession({ sessionId: hit.sessionId, entryId: hit.entryId, leafId: hit.leafId }, source),
		).rejects.toThrow();
	});

	it("rejects duplicate session IDs rather than choosing an arbitrary file", async () => {
		const first = await session("duplicate", [message("a", null, "sentinel")]);
		await writeFile(join(source.sessionDir, "copy.jsonl"), await readFile(first));
		await expect(readSession({ sessionId: "duplicate", entryId: "a", leafId: "a" }, source)).rejects.toThrow();
	});

	it("supports cancellation and validates query, dates, and output bounds", async () => {
		await session("one", [message("a", null, "sentinel")]);
		await expect(searchSessions({ query: "sentinel" }, source, AbortSignal.abort())).rejects.toThrow();
		for (const input of [
			{ query: "" },
			{ query: '"unclosed' },
			{ query: "sentinel", limit: 101 },
			{ query: "sentinel", after: "invalid" },
			{ query: "sentinel", after: "2026-10-02", before: "2026-10-01" },
		])
			await expect(searchSessions(input, source)).rejects.toThrow();
		await expect(readSession({ sessionId: "one", entryId: "a", leafId: "a", maxChars: 0 }, source)).rejects.toThrow();
	});
});
