import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
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
type GrepMode = "content" | "files" | "count";
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
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

/** The subset of ripgrep's `--json` messages this tool reads. */
interface RgJsonEvent {
	type: string;
	data?: {
		path?: { text?: string };
		line_number?: number;
		lines?: { text?: string };
		stats?: { matches?: number };
	};
}

interface ContentMatch {
	filePath: string;
	lineNumber: number;
	lineText?: string;
}

interface FileCount {
	filePath: string;
	count: number;
}

const toArray = (value: string | string[] | undefined): string[] =>
	value === undefined ? [] : Array.isArray(value) ? value : [value];

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers, the paths of matching files (mode "files"), or match counts per file (mode "count"). Respects .gitignore. Results are sorted by path; page through them with skip. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars. With several paths, result paths are relative to the working directory.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(_toolCallId, params: GrepToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const { pattern, ignoreCase, literal, multiline, context, limit, skip } = params;
			const mode: GrepMode = params.mode ?? "content";
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg");
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						const workingDir = ctx?.cwd || cwd;
						const requestedPaths = toArray(params.path);
						const searchPaths = (requestedPaths.length > 0 ? requestedPaths : ["."]).map((p) =>
							resolveToCwd(p || ".", workingDir),
						);
						const ops = customOps ?? defaultGrepOperations;
						const directoryFlags: boolean[] = [];
						for (const searchPath of searchPaths) {
							try {
								directoryFlags.push(await ops.isDirectory(searchPath));
							} catch {
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								return;
							}
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const skipCount = Math.max(0, Math.floor(skip ?? 0));
						// One path keeps the historical format (relative to that directory, or the file's
						// basename); several paths are made relative to the working directory so results
						// from different roots stay distinguishable.
						const singlePath = searchPaths.length === 1;
						const baseDir = singlePath ? (directoryFlags[0] ? searchPaths[0] : undefined) : workingDir;
						const formatPath = (filePath: string): string => {
							if (baseDir !== undefined) {
								const relative = path.relative(baseDir, filePath);
								if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
									return relative.replace(/\\/g, "/");
								}
							}
							return singlePath ? path.basename(filePath) : filePath.replace(/\\/g, "/");
						};

						const fileCache = new Map<string, string[]>();
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

						// --no-config: the tool contract (literal, glob, limit, ...) must not depend on
						// ambient user config like RIPGREP_CONFIG_PATH. Users can customize via bash or extensions.
						// --sort path: paging with skip needs the same order on every call.
						const args: string[] = [
							"--no-config",
							"--json",
							"--line-number",
							"--color=never",
							"--hidden",
							"--sort",
							"path",
						];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (multiline) args.push("--multiline");
						// One match per file is enough to list it.
						if (mode === "files") args.push("--max-count", "1");
						for (const glob of toArray(params.glob)) args.push("--glob", glob);
						args.push("--", pattern, ...searchPaths);

						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let resultCount = 0;
						let limitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						// Counts one result and reports whether it belongs to the requested page. The first
						// result past the page proves there is a next page, so ripgrep can stop there.
						const takeResult = (): boolean => {
							resultCount++;
							if (resultCount <= skipCount) return false;
							if (resultCount > skipCount + effectiveLimit) {
								limitReached = true;
								stopChild(true);
								return false;
							}
							return true;
						};

						const matches: ContentMatch[] = [];
						const listedFiles: string[] = [];
						const fileCounts: FileCount[] = [];
						rl.on("line", (line) => {
							if (!line.trim() || limitReached) return;
							let event: RgJsonEvent;
							try {
								event = JSON.parse(line) as RgJsonEvent;
							} catch {
								return;
							}
							const filePath = event.data?.path?.text;
							if (!filePath) return;
							if (mode === "count") {
								const count = event.data?.stats?.matches;
								if (event.type === "end" && count && takeResult()) fileCounts.push({ filePath, count });
								return;
							}
							if (event.type !== "match") return;
							if (mode === "files") {
								if (listedFiles.at(-1) !== filePath && takeResult()) listedFiles.push(filePath);
								return;
							}
							const lineNumber = event.data?.line_number;
							if (typeof lineNumber === "number" && takeResult()) {
								matches.push({ filePath, lineNumber, lineText: event.data?.lines?.text });
							}
						});

						const formatBlock = async (filePath: string, firstLine: number, lastLine: number) => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${firstLine}: (unable to read file)`];
							const block: string[] = [];
							const start = Math.max(1, firstLine - contextValue);
							const end = Math.min(lines.length, lastLine + contextValue);
							for (let current = start; current <= end; current++) {
								const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
								// Truncate long lines so grep output stays compact.
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) linesTruncated = true;
								const isMatchLine = current >= firstLine && current <= lastLine;
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							return block;
						};

						const formatMatch = async (match: ContentMatch): Promise<string[]> => {
							// ripgrep reports the matched text; a multiline match spans several lines.
							const matchLines =
								match.lineText === undefined
									? undefined
									: match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "").split("\n");
							const lastLine = match.lineNumber + (matchLines?.length ?? 1) - 1;
							if (contextValue > 0 || matchLines === undefined) {
								return formatBlock(match.filePath, match.lineNumber, lastLine);
							}
							const relativePath = formatPath(match.filePath);
							return matchLines.map((text, index) => {
								const { text: truncatedText, wasTruncated } = truncateLine(text);
								if (wasTruncated) linesTruncated = true;
								return `${relativePath}:${match.lineNumber + index}: ${truncatedText}`;
							});
						};

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", async (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (resultCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}
							if (resultCount <= skipCount) {
								const unit = mode === "content" ? "matches" : "files";
								const text = `No results after skip=${skipCount} (${resultCount} ${unit} in total)`;
								settle(() => resolve({ content: [{ type: "text", text }], details: undefined }));
								return;
							}

							// Format matches after streaming finishes so custom readFile() backends can be async.
							const outputLines: string[] = [];
							if (mode === "files") outputLines.push(...listedFiles.map(formatPath));
							else if (mode === "count") {
								outputLines.push(
									...fileCounts.map(({ filePath, count }) => `${formatPath(filePath)}:${count}`),
								);
							} else {
								for (const match of matches) outputLines.push(...(await formatMatch(match)));
							}

							const rawOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the result limit already capped rows.
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let output = truncation.content;
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and result limits.
							const notices: string[] = [];
							if (limitReached) {
								const nextSkip = skipCount + effectiveLimit;
								const unit = mode === "content" ? "matches" : "files";
								notices.push(
									`${effectiveLimit} ${unit} limit reached. Use skip=${nextSkip} for more, or refine pattern`,
								);
								if (mode === "content") details.matchLimitReached = effectiveLimit;
								else details.fileLimitReached = effectiveLimit;
								details.nextSkip = nextSkip;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		...grepRenderers,
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
