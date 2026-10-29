// Read-only, branch-aware retrieval of persisted session text.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getSessionsDir } from "../../config.ts";
import { buildContextEntries, type SessionEntry, type SessionHeader } from "../../core/session-manager.ts";

export interface SessionSearchSource {
	cwd: string;
	sessionDir: string;
	currentSessionId: string;
}

export interface SessionScope {
	cwd?: string;
	includeCurrent?: boolean;
	includeOriginal?: boolean;
}

export interface SessionSearchInput extends SessionScope {
	query: string;
	role?: "user" | "assistant" | "summary";
	after?: string;
	before?: string;
	limit?: number;
}

export interface SessionReadInput extends SessionScope {
	sessionId: string;
	entryId: string;
	leafId: string;
	before?: number;
	after?: number;
	maxChars?: number;
}

export type SessionText = {
	entryId: string;
	parentId: string | null;
	timestamp: string;
	role: "user" | "assistant" | "summary";
	kind: "message" | "compaction" | "branch_summary";
	text: string;
	context: "retained" | "summarized";
	edit: "unchanged" | "replaced" | "omitted";
	view: "effective" | "original";
};

export type SessionMatch = Omit<SessionText, "text"> & {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	leafId: string;
	excerpt: string;
	excerptTruncated: boolean;
};

interface LoadedSession {
	header: SessionHeader;
	file: string;
	entries: SessionEntry[];
	leaves: string[];
}

interface ScanResult {
	sessions: LoadedSession[];
	warnings: { path: string; reason: string }[];
	warningCount: number;
}

/** Search literal terms (AND) and quoted phrases, returning bounded source references. */
export async function searchSessions(input: SessionSearchInput, source: SessionSearchSource, signal?: AbortSignal) {
	const terms = parseTerms(input.query);
	const limit = boundedInteger(input.limit, 20, 1, 100, "limit");
	const after = dateBoundary(input.after, -Infinity);
	const before = dateBoundary(input.before, Infinity);
	if (after > before) throw new Error("after must not be later than before");
	const scan = await scanSessions(input, source, signal);
	const matches: SessionMatch[] = [];
	let totalMatches = 0;
	// Keep only the best bounded results, not every matching transcript.
	for (const session of scan.sessions) {
		for (const leafId of session.leaves) {
			signal?.throwIfAborted();
			for (const item of branchText(session, leafId, input.includeOriginal ?? false)) {
				if (input.role && input.role !== item.role) continue;
				const time = Date.parse(item.timestamp);
				if (time < after || time > before) continue;
				const lower = item.text.toLowerCase();
				if (!terms.every((term) => lower.includes(term))) continue;
				totalMatches++;
				const start = Math.max(0, lower.indexOf(terms[0]) - 120);
				const { text, ...reference } = item;
				matches.push({
					...reference,
					sessionId: session.header.id,
					sessionFile: session.file,
					cwd: session.header.cwd,
					leafId,
					excerpt: text.slice(start, start + 400),
					excerptTruncated: start > 0 || text.length > start + 400,
				});
				matches.sort(
					(a, b) =>
						Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
						a.sessionFile.localeCompare(b.sessionFile) ||
						a.leafId.localeCompare(b.leafId) ||
						a.entryId.localeCompare(b.entryId),
				);
				if (matches.length > limit) matches.pop();
			}
		}
	}
	return {
		cwd: resolve(source.cwd, input.cwd ?? "."),
		matches,
		totalMatches,
		truncated: totalMatches > matches.length,
		scannedSessions: scan.sessions.length,
		warnings: scan.warnings,
		warningCount: scan.warningCount,
		incomplete: scan.warningCount > 0,
	};
}

/** Read a bounded text window along one explicitly selected terminal branch. */
export async function readSession(input: SessionReadInput, source: SessionSearchSource, signal?: AbortSignal) {
	const before = boundedInteger(input.before, 2, 0, 20, "before");
	const after = boundedInteger(input.after, 2, 0, 20, "after");
	const maxChars = boundedInteger(input.maxChars, 12000, 1, 40000, "maxChars");
	const scan = await scanSessions(input, source, signal);
	const sessions = scan.sessions.filter((session) => session.header.id === input.sessionId);
	if (sessions.length !== 1)
		throw new Error(
			sessions.length
				? "Ambiguous session ID in this scope"
				: "Session not found in this scope; search again and check warnings",
		);
	const session = sessions[0];
	if (!session.leaves.includes(input.leafId)) throw new Error("Branch changed or leaf not found; search again");
	const items = branchText(session, input.leafId, input.includeOriginal ?? false);
	const index = items.findIndex((item) => item.entryId === input.entryId);
	if (index < 0)
		throw new Error("Entry is not visible on this branch; search again or explicitly request includeOriginal");
	const start = Math.max(0, index - before);
	const end = Math.min(items.length, index + after + 1);
	const selected = items.slice(start, end);
	// Reserve the budget for the target before its surrounding messages.
	let remaining = maxChars;
	const target = selected[index - start];
	const targetText = target.text.slice(0, remaining);
	remaining -= targetText.length;
	const entries = selected.map((item) => {
		const text = item === target ? targetText : item.text.slice(0, remaining);
		if (item !== target) remaining -= text.length;
		return { ...item, text, textTruncated: text.length < item.text.length };
	});
	return {
		sessionId: session.header.id,
		sessionFile: session.file,
		cwd: session.header.cwd,
		leafId: input.leafId,
		entries,
		hasEarlier: start > 0,
		hasLater: end < items.length,
		truncated: entries.some((entry) => entry.textTruncated),
		warnings: scan.warnings,
		warningCount: scan.warningCount,
		incomplete: scan.warningCount > 0,
	};
}

function parseTerms(query: string): string[] {
	if (!query.trim()) throw new Error("query must not be empty");
	if ((query.match(/"/g)?.length ?? 0) % 2 !== 0) throw new Error("Unclosed quoted phrase");
	const terms = [...query.matchAll(/"([^"]+)"|([^\s"]+)/g)].map((match) => (match[1] ?? match[2]).toLowerCase());
	if (!terms.length) throw new Error("query must contain searchable text");
	return terms;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || result < min || result > max)
		throw new Error(`${name} must be an integer from ${min} to ${max}`);
	return result;
}

function dateBoundary(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const time = Date.parse(value);
	if (!Number.isFinite(time)) throw new Error("Invalid date boundary");
	return time;
}

async function scanSessions(
	scope: SessionScope,
	source: SessionSearchSource,
	signal?: AbortSignal,
): Promise<ScanResult> {
	signal?.throwIfAborted();
	const cwd = resolve(source.cwd, scope.cwd ?? ".");
	const result: ScanResult = { sessions: [], warnings: [], warningCount: 0 };
	const warn = (path: string, reason: string) => {
		result.warningCount++;
		if (result.warnings.length < 10) result.warnings.push({ path, reason });
	};
	const directories = new Set<string>();
	if (source.sessionDir) directories.add(resolve(source.sessionDir));
	if (cwd !== resolve(source.cwd) || !source.sessionDir) {
		const root = getSessionsDir();
		try {
			for (const entry of await readdir(root, { withFileTypes: true })) {
				if (entry.isDirectory() || entry.isSymbolicLink()) directories.add(join(root, entry.name));
			}
		} catch (error) {
			if (!isMissing(error)) warn(root, "Cannot list session storage");
		}
	}
	for (const directory of directories) {
		signal?.throwIfAborted();
		let files: string[];
		try {
			files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
		} catch (error) {
			if (!isMissing(error)) warn(directory, "Cannot list session directory");
			continue;
		}
		for (const name of files) {
			signal?.throwIfAborted();
			const file = join(directory, name);
			try {
				const session = await loadSession(file, signal);
				if (resolve(session.header.cwd) !== cwd) continue;
				if (!scope.includeCurrent && session.header.id === source.currentSessionId) continue;
				result.sessions.push(session);
			} catch (error) {
				signal?.throwIfAborted();
				warn(file, error instanceof Error ? error.message : "Cannot read session");
			}
		}
	}
	signal?.throwIfAborted();
	return result;
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function loadSession(file: string, signal?: AbortSignal): Promise<LoadedSession> {
	const initial = await stat(file);
	const content = await readFile(file, { encoding: "utf8", signal });
	const final = await stat(file);
	if (initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ino !== final.ino)
		throw new Error("Session changed during read; retry");
	let values: unknown[];
	try {
		values = content
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	} catch {
		throw new Error("Malformed JSONL; session skipped");
	}
	const header = values.shift();
	if (
		!isObject(header) ||
		header.type !== "session" ||
		typeof header.id !== "string" ||
		typeof header.cwd !== "string" ||
		!header.cwd ||
		typeof header.timestamp !== "string"
	)
		throw new Error("Invalid session header");
	if (header.version !== 2 && header.version !== 3) throw new Error("Only session versions 2 and 3 are searchable");
	const entries: SessionEntry[] = [];
	const ids = new Set<string>();
	const parents = new Set<string>();
	for (const value of values) {
		// The JSONL boundary must have stable IDs and an acyclic, append-ordered tree.
		if (
			!isObject(value) ||
			typeof value.type !== "string" ||
			typeof value.id !== "string" ||
			!value.id ||
			ids.has(value.id) ||
			typeof value.timestamp !== "string" ||
			!Number.isFinite(Date.parse(value.timestamp)) ||
			(value.parentId !== null && (typeof value.parentId !== "string" || !ids.has(value.parentId)))
		)
			throw new Error("Invalid session tree");
		if (value.type === "message") {
			if (!isObject(value.message) || typeof value.message.role !== "string") throw new Error("Invalid message");
			if (value.message.role === "user" || value.message.role === "assistant")
				validateContent(value.message.content);
		} else if (value.type === "context_edit") {
			if (typeof value.targetId !== "string" || !ids.has(value.targetId))
				throw new Error("Invalid context edit target");
			if (value.replacement !== null) {
				if (!isObject(value.replacement)) throw new Error("Invalid context edit replacement");
				validateContent(value.replacement.content);
			}
		} else if (value.type === "compaction" || value.type === "branch_summary") {
			if (
				typeof value.summary !== "string" ||
				(value.type === "compaction" && typeof value.firstKeptEntryId !== "string")
			)
				throw new Error("Invalid summary");
		}
		ids.add(value.id);
		if (typeof value.parentId === "string") parents.add(value.parentId);
		// Only the fields consumed by retrieval are validated; unrelated metadata stays opaque.
		entries.push(value as unknown as SessionEntry);
	}
	return {
		header: header as unknown as SessionHeader,
		file,
		entries,
		leaves: entries.filter((entry) => !parents.has(entry.id)).map((entry) => entry.id),
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateContent(content: unknown): void {
	// Wire content may contain images, thinking, or tool calls, but only text is exposed.
	if (typeof content === "string") return;
	if (
		!Array.isArray(content) ||
		content.some(
			(block) =>
				!isObject(block) ||
				typeof block.type !== "string" ||
				(block.type === "text" && typeof block.text !== "string"),
		)
	)
		throw new Error("Invalid message content");
}

function contentText(content: string | readonly { type: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function branchText(session: LoadedSession, leafId: string, includeOriginal: boolean): SessionText[] {
	const index = new Map(session.entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	let current = index.get(leafId);
	while (current) {
		path.push(current);
		current = current.parentId === null ? undefined : index.get(current.parentId);
	}
	path.reverse();
	const retained = new Set(buildContextEntries(session.entries, leafId, index).map((entry) => entry.id));
	const edits = new Map(path.filter((entry) => entry.type === "context_edit").map((entry) => [entry.targetId, entry]));
	const items: SessionText[] = [];
	for (const entry of path) {
		let role: SessionText["role"];
		let text: string;
		if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
			role = entry.message.role;
			text = contentText(entry.message.content);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			role = "summary";
			text = entry.summary;
		} else continue;
		const edit = edits.get(entry.id);
		if (!includeOriginal && edit) {
			if (edit.replacement === null) continue;
			text = contentText(edit.replacement.content);
		}
		if (!text) continue;
		items.push({
			entryId: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			role,
			kind: entry.type,
			text,
			context: retained.has(entry.id) ? "retained" : "summarized",
			edit: !edit ? "unchanged" : edit.replacement === null ? "omitted" : "replaced",
			view: includeOriginal ? "original" : "effective",
		});
	}
	return items;
}
