/**
 * Git worktrees that pi creates for isolated work: `--worktree`, `/worktree`, and the `enter_worktree` tool.
 *
 * Worktrees live outside the repository, in `<agentDir>/worktrees/<repo>-<hash>/<name>`, on a `pi/<name>`
 * branch cut from the current HEAD. Gitignored files listed in `.worktreeinclude` are copied in.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "../config.ts";
import { isPathWithin } from "../utils/paths.ts";

const execFileAsync = promisify(execFile);

export const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const WORKTREE_BRANCH_PREFIX = "pi/";

export interface RepoInfo {
	/** Root of the main checkout, shared by all linked worktrees. */
	repoRoot: string;
	/** Root of the checkout that contains cwd. */
	topLevel: string;
	/** Whether cwd is inside a linked worktree (not the main checkout or a submodule). */
	isLinkedWorktree: boolean;
}

export interface WorktreeRecord {
	path: string;
	branch: string;
	/** Commit the branch started from; new commits past it keep the worktree on cleanup. */
	baseSha: string;
	repoRoot: string;
}

/** Worktrees this process created. Only these are cleaned up on quit, never ones a session merely entered. */
export const createdWorktrees = new Map<string, WorktreeRecord>();

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
	try {
		await git(cwd, args);
		return true;
	} catch {
		return false;
	}
}

/** Returns undefined when cwd is not inside a git checkout. */
export async function resolveRepo(cwd: string): Promise<RepoInfo | undefined> {
	let output: string;
	try {
		output = await git(cwd, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
			"--show-toplevel",
			"--git-dir",
		]);
	} catch {
		return undefined;
	}
	const [commonDir, topLevel, gitDir] = output.split("\n");
	if (!commonDir || !topLevel || !gitDir) return undefined;
	// A submodule's git dir also differs from its common dir, but it is not a linked worktree.
	const superproject = await git(cwd, ["rev-parse", "--show-superproject-working-tree"]).catch(() => "");
	return {
		repoRoot: basename(commonDir) === ".git" ? dirname(commonDir) : topLevel,
		topLevel,
		isLinkedWorktree: realpathSync(gitDir) !== realpathSync(commonDir) && superproject === "",
	};
}

export function worktreesRoot(repoRoot: string): string {
	const real = realpathSync(repoRoot);
	const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
	return join(getAgentDir(), "worktrees", `${basename(real)}-${hash}`);
}

export function randomWorktreeName(): string {
	return randomBytes(4).toString("hex");
}

export async function validateWorktreeName(cwd: string, name: string): Promise<void> {
	if (!WORKTREE_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid worktree name "${name}": use letters, digits, ".", "_" or "-" (max 64)`);
	}
	if (!(await gitSucceeds(cwd, ["check-ref-format", "--branch", `${WORKTREE_BRANCH_PREFIX}${name}`]))) {
		throw new Error(`Invalid worktree name "${name}": not a valid git branch name`);
	}
}

/** Paths of the registered worktrees of the repository. */
export async function listWorktreePaths(cwd: string): Promise<string[]> {
	const output = await git(cwd, ["worktree", "list", "--porcelain"]);
	return output
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

/**
 * Copy the gitignored files listed in `.worktreeinclude` from the source checkout.
 * Returns warnings for skipped lines.
 */
export async function copyWorktreeInclude(sourceRoot: string, targetRoot: string): Promise<string[]> {
	const includeFile = join(sourceRoot, ".worktreeinclude");
	if (!existsSync(includeFile)) return [];
	const warnings: string[] = [];
	// shortcut: literal paths only, no gitignore-style globs; add pattern matching if users need it.
	for (const rawLine of readFileSync(includeFile, "utf8").split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		if (/[*?[]/.test(line) || line.startsWith("!")) {
			warnings.push(`.worktreeinclude: skipped pattern "${line}" (only literal paths are supported)`);
			continue;
		}
		const relative = line.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
		const segments = relative.split("/");
		if (isAbsolute(line) || segments.some((s) => s === "" || s === "." || s === ".." || s === ".git")) {
			warnings.push(`.worktreeinclude: skipped unsafe path "${line}"`);
			continue;
		}
		const source = join(sourceRoot, relative);
		if (!existsSync(source)) continue;
		// Tracked files are already in the worktree; unignored untracked files are not meant to be copied.
		if (!(await gitSucceeds(sourceRoot, ["check-ignore", "-q", "--", relative]))) continue;
		const target = join(targetRoot, relative);
		if (existsSync(target)) continue;
		try {
			cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
		} catch (error) {
			// The worktree already exists, so a failed copy must not fail the whole creation.
			warnings.push(`.worktreeinclude: could not copy "${line}": ${error instanceof Error ? error.message : error}`);
		}
	}
	return warnings;
}

export interface CreateWorktreeResult {
	record: WorktreeRecord;
	warnings: string[];
}

/** Create `pi/<name>` from cwd's HEAD in a new worktree outside the repository. */
export async function createWorktree(cwd: string, name: string = randomWorktreeName()): Promise<CreateWorktreeResult> {
	const repo = await resolveRepo(cwd);
	if (!repo) throw new Error("Not inside a git repository");
	await validateWorktreeName(cwd, name);
	const path = join(worktreesRoot(repo.repoRoot), name);
	const branch = `${WORKTREE_BRANCH_PREFIX}${name}`;
	if (existsSync(path)) throw new Error(`Worktree path already exists: ${path}`);
	if (await gitSucceeds(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
		throw new Error(`Branch already exists: ${branch}`);
	}
	const baseSha = await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => {
		throw new Error("The repository has no commits yet");
	});
	await git(repo.topLevel, ["worktree", "add", "-b", branch, path, baseSha]);
	const record: WorktreeRecord = { path: realpathSync(path), branch, baseSha, repoRoot: repo.repoRoot };
	createdWorktrees.set(record.path, record);
	const warnings = await copyWorktreeInclude(repo.topLevel, record.path);
	return { record, warnings };
}

/**
 * Remove a created worktree and its branch when it has no changes and no new commits.
 * Returns a message when the worktree is kept, undefined when it was removed.
 */
export async function cleanupCreatedWorktree(record: WorktreeRecord): Promise<string | undefined> {
	const kept = `Worktree kept: ${record.path} (branch ${record.branch}). Remove with: git worktree remove ${record.path}`;
	if (!existsSync(record.path)) {
		createdWorktrees.delete(record.path);
		return undefined;
	}
	try {
		const status = await git(record.path, ["status", "--porcelain"]);
		// HEAD may have moved to another branch, so the pi branch is checked too.
		const newCommits = await git(record.path, ["rev-list", "--count", "HEAD", record.branch, `^${record.baseSha}`]);
		if (status !== "" || newCommits !== "0") return kept;
		// Windows cannot delete a process's cwd, which --worktree sets to the worktree.
		if (isPathWithin(record.path, process.cwd())) process.chdir(record.repoRoot);
		await git(record.repoRoot, ["worktree", "remove", record.path]);
		// No commits past the base, so deleting the branch loses nothing.
		await git(record.repoRoot, ["branch", "-D", record.branch]);
		createdWorktrees.delete(record.path);
		return undefined;
	} catch {
		return kept;
	}
}
