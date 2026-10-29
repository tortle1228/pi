/**
 * The contract between the grep tool and the engine that searches files.
 *
 * An engine only finds hits. Paging, path display, context lines, and truncation stay in the tool, so every engine
 * produces the same output for the same hits.
 */

export type GrepMode = "content" | "files" | "count";

export interface GrepEngineRequest {
	/** Regex, or a literal string when `literal` is set. */
	pattern: string;
	/** Absolute paths of the files and directories to search, in the order given. */
	paths: string[];
	/** ripgrep-style globs; a leading `!` excludes. Empty: every file. */
	globs: string[];
	ignoreCase: boolean;
	literal: boolean;
	/** Matches may span lines. */
	multiline: boolean;
	mode: GrepMode;
	/** Stop after this many hits. */
	maxHits: number;
}

/**
 * One result. `content` mode yields `match` hits, one per match (a multiline match is one hit whose `lineText` spans
 * its lines); `files` mode yields one `file` hit per matching file; `count` mode one `count` hit per matching file.
 */
export type GrepHit =
	| {
			type: "match";
			/** Absolute path. */
			filePath: string;
			/** 1-based line of the match's first line. */
			lineNumber: number;
			/** The matched lines, with their line ends. Unset when the engine cannot decode them, for example non-UTF-8 text. */
			lineText?: string;
	  }
	| { type: "file"; filePath: string }
	| { type: "count"; filePath: string; count: number };

/**
 * Searches files for the grep tool.
 *
 * Every engine searches like ripgrep with `--hidden`: it respects `.gitignore` and ignore files, includes hidden
 * files, skips binary files, and orders hits by path, then by line. An aborted search rejects with
 * `Error("Operation aborted")`.
 */
export interface GrepEngine {
	search(request: GrepEngineRequest, signal?: AbortSignal): Promise<GrepHit[]>;
}
