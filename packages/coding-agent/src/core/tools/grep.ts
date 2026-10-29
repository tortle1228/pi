import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import path from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { GrepEngine, GrepHit, GrepMode } from "./grep-engine.ts";
import { createRgGrepEngine } from "./grep-rg-engine.ts";
import { resolveToCwd } from "./path-utils.ts";
import { grepRenderers } from "./renderers/grep.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const stringOrStrings = (description: string) =>
	Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description }));

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: stringOrStrings("Directory or file to search, or a list of them (default: current directory)"),
	glob: stringOrStrings(
		"Filter files by glob pattern, or a list of patterns, e.g. '*.ts' or ['src/**', '!**/*.spec.ts']",
	),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	multiline: Type.Optional(Type.Boolean({ description: "Allow matches to span multiple lines (default: false)" })),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	mode: Type.Optional(
		StringEnum(["content", "files", "count"] as const, {
			description:
				"content: matching lines (default); files: paths of matching files; count: number of matches per file",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum number of results: matches in content mode, files otherwise (default: 100)",
		}),
	),
	skip: Type.Optional(Type.Number({ description: "Number of results to skip, for paging (default: 0)" })),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
	guidelines: [],
} as const;

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	/** Set in content mode when more matches exist beyond the returned page. */
	matchLimitReached?: number;
	/** Set in files and count modes when more files exist beyond the returned page. */
	fileLimitReached?: number;
	/** The `skip` value that returns the next page. Set together with a limit field. */
	nextSkip?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem */
	operations?: GrepOperations;
	/** Search engine. Default: ripgrep */
	engine?: GrepEngine;
}

const toArray = (value: string | string[] | undefined): string[] =>
	value === undefined ? [] : Array.isArray(value) ? value : [value];

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const ops = options?.operations ?? defaultGrepOperations;
	const engine = options?.engine ?? createRgGrepEngine();
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers, the paths of matching files (mode "files"), or match counts per file (mode "count"). Respects .gitignore. Results are sorted by path; page through them with skip. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars. With several paths, result paths are relative to the working directory.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(_toolCallId, params: GrepToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const mode: GrepMode = params.mode ?? "content";
			const workingDir = ctx?.cwd || cwd;
			const requestedPaths = toArray(params.path);
			const searchPaths = (requestedPaths.length > 0 ? requestedPaths : ["."]).map((p) =>
				resolveToCwd(p || ".", workingDir),
			);
			const directoryFlags: boolean[] = [];
			for (const searchPath of searchPaths) {
				try {
					directoryFlags.push(await ops.isDirectory(searchPath));
				} catch {
					throw new Error(`Path not found: ${searchPath}`);
				}
			}

			const limit = Math.max(1, params.limit ?? DEFAULT_LIMIT);
			const skip = Math.max(0, Math.floor(params.skip ?? 0));
			// One hit past the page proves there is a next page.
			const hits = await engine.search(
				{
					pattern: params.pattern,
					paths: searchPaths,
					globs: toArray(params.glob),
					ignoreCase: params.ignoreCase ?? false,
					literal: params.literal ?? false,
					multiline: params.multiline ?? false,
					mode,
					maxHits: skip + limit + 1,
				},
				signal,
			);
			if (hits.length === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			const unit = mode === "content" ? "matches" : "files";
			if (hits.length <= skip) {
				const text = `No results after skip=${skip} (${hits.length} ${unit} in total)`;
				return { content: [{ type: "text", text }], details: undefined };
			}

			const formatter = createHitFormatter({
				ops,
				formatPath: createPathFormatter(searchPaths, directoryFlags, workingDir),
				context: params.context && params.context > 0 ? params.context : 0,
			});
			const outputLines: string[] = [];
			// Format after the search so custom readFile() backends can be async.
			for (const hit of hits.slice(skip, skip + limit)) outputLines.push(...(await formatter.format(hit)));

			// Apply byte truncation. There is no line limit here because the result limit already capped rows.
			const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: GrepToolDetails = {};
			// Build actionable notices for truncation and result limits.
			const notices: string[] = [];
			if (hits.length > skip + limit) {
				const nextSkip = skip + limit;
				notices.push(`${limit} ${unit} limit reached. Use skip=${nextSkip} for more, or refine pattern`);
				if (mode === "content") details.matchLimitReached = limit;
				else details.fileLimitReached = limit;
				details.nextSkip = nextSkip;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (formatter.linesTruncated()) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
		...grepRenderers,
	};
}

/**
 * Formats result paths. One path keeps the historical format (relative to that directory, or the file's basename);
 * several paths are made relative to the working directory so results from different roots stay distinguishable.
 */
function createPathFormatter(
	searchPaths: string[],
	directoryFlags: boolean[],
	workingDir: string,
): (filePath: string) => string {
	const singlePath = searchPaths.length === 1;
	const baseDir = singlePath ? (directoryFlags[0] ? searchPaths[0] : undefined) : workingDir;
	return (filePath) => {
		if (baseDir !== undefined) {
			const relative = path.relative(baseDir, filePath);
			if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.replace(/\\/g, "/");
		}
		return singlePath ? path.basename(filePath) : filePath.replace(/\\/g, "/");
	};
}

/** Turns hits into output lines, reading files for context lines and recording whether any line was truncated. */
function createHitFormatter(options: {
	ops: GrepOperations;
	formatPath: (filePath: string) => string;
	context: number;
}): { format(hit: GrepHit): Promise<string[]>; linesTruncated(): boolean } {
	const { ops, formatPath, context } = options;
	const fileCache = new Map<string, string[]>();
	let linesTruncated = false;

	const truncate = (text: string): string => {
		const { text: truncatedText, wasTruncated } = truncateLine(text);
		if (wasTruncated) linesTruncated = true;
		return truncatedText;
	};

	const getFileLines = async (filePath: string): Promise<string[]> => {
		let lines = fileCache.get(filePath);
		if (!lines) {
			try {
				const content = await ops.readFile(filePath);
				lines = content.replace(/\r\n/g, "\n").split("\n");
			} catch {
				lines = [];
			}
			fileCache.set(filePath, lines);
		}
		return lines;
	};

	const formatBlock = async (filePath: string, firstLine: number, lastLine: number): Promise<string[]> => {
		const relativePath = formatPath(filePath);
		const lines = await getFileLines(filePath);
		if (!lines.length) return [`${relativePath}:${firstLine}: (unable to read file)`];
		const block: string[] = [];
		const start = Math.max(1, firstLine - context);
		const end = Math.min(lines.length, lastLine + context);
		for (let current = start; current <= end; current++) {
			// Truncate long lines so grep output stays compact.
			const text = truncate((lines[current - 1] ?? "").replace(/\r/g, ""));
			const isMatchLine = current >= firstLine && current <= lastLine;
			block.push(isMatchLine ? `${relativePath}:${current}: ${text}` : `${relativePath}-${current}- ${text}`);
		}
		return block;
	};

	return {
		async format(hit) {
			if (hit.type === "file") return [formatPath(hit.filePath)];
			if (hit.type === "count") return [`${formatPath(hit.filePath)}:${hit.count}`];
			// The engine reports the matched text; a multiline match spans several lines.
			const matchLines = hit.lineText?.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "").split("\n");
			const lastLine = hit.lineNumber + (matchLines?.length ?? 1) - 1;
			if (context > 0 || matchLines === undefined) return formatBlock(hit.filePath, hit.lineNumber, lastLine);
			const relativePath = formatPath(hit.filePath);
			return matchLines.map((text, index) => `${relativePath}:${hit.lineNumber + index}: ${truncate(text)}`);
		},
		linesTruncated: () => linesTruncated,
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
