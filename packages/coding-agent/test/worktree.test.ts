import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanupCreatedWorktree,
	createdWorktrees,
	createWorktree,
	resolveRepo,
	worktreesRoot,
} from "../src/core/worktree.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("worktree", () => {
	let root: string;
	let repo: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		repo = join(root, "repo");
		execFileSync("git", ["init", "-q", "-b", "main", repo]);
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, ".gitignore"), ".env\nsecret/\nloose.txt\n");
		writeFileSync(join(repo, "tracked.txt"), "tracked\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
	});

	afterEach(() => {
		createdWorktrees.clear();
		rmSync(root, { recursive: true, force: true });
	});

	it("creates pi/<name> from HEAD outside the repository", async () => {
		const { record } = await createWorktree(repo, "feat");
		expect(record.path).toBe(join(worktreesRoot(repo), "feat"));
		expect(record.path.startsWith(join(root, "agent", "worktrees"))).toBe(true);
		expect(record.branch).toBe("pi/feat");
		expect(record.baseSha).toBe(git(repo, "rev-parse", "HEAD"));
		expect(git(record.path, "branch", "--show-current")).toBe("pi/feat");
		expect(createdWorktrees.get(record.path)).toEqual(record);

		const info = await resolveRepo(record.path);
		expect(info?.isLinkedWorktree).toBe(true);
		expect(info?.repoRoot).toBe(repo);
		expect((await resolveRepo(repo))?.isLinkedWorktree).toBe(false);
	});

	it("rejects duplicate and invalid names", async () => {
		await createWorktree(repo, "feat");
		await expect(createWorktree(repo, "feat")).rejects.toThrow(/already exists/);
		await expect(createWorktree(repo, "-bad")).rejects.toThrow(/Invalid worktree name/);
		await expect(createWorktree(repo, "a..b")).rejects.toThrow(/not a valid git branch name/);
		await expect(createWorktree(root, "x")).rejects.toThrow(/Not inside a git repository/);
	});

	it("copies only literal, existing, gitignored .worktreeinclude entries", async () => {
		writeFileSync(join(repo, ".env"), "KEY=1\n");
		execFileSync("mkdir", ["-p", join(repo, "secret")]);
		writeFileSync(join(repo, "secret", "a.txt"), "a\n");
		writeFileSync(join(repo, "untracked.txt"), "not ignored\n");
		writeFileSync(
			join(repo, ".worktreeinclude"),
			"# comment\n\n.env\nsecret/\ntracked.txt\nuntracked.txt\nmissing.txt\n*.log\n../outside\n",
		);

		const { record, warnings } = await createWorktree(repo, "inc");

		expect(readFileSync(join(record.path, ".env"), "utf8")).toBe("KEY=1\n");
		expect(readFileSync(join(record.path, "secret", "a.txt"), "utf8")).toBe("a\n");
		expect(existsSync(join(record.path, "untracked.txt"))).toBe(false);
		expect(existsSync(join(record.path, "missing.txt"))).toBe(false);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("*.log");
		expect(warnings[1]).toContain("../outside");
	});

	it.skipIf(process.getuid?.() === 0)("reports a failed copy as a warning instead of failing", async () => {
		mkdirSync(join(repo, "secret", "locked"), { recursive: true });
		writeFileSync(join(repo, "secret", "locked", "x.txt"), "x\n");
		chmodSync(join(repo, "secret", "locked"), 0o000);
		writeFileSync(join(repo, ".worktreeinclude"), "secret\n");
		try {
			const { record, warnings } = await createWorktree(repo, "locked");
			expect(existsSync(record.path)).toBe(true);
			expect(warnings.some((w) => w.includes('could not copy "secret"'))).toBe(true);
		} finally {
			chmodSync(join(repo, "secret", "locked"), 0o755);
		}
	});

	it("leaves the worktree before removing it when it is the process cwd", async () => {
		const { record } = await createWorktree(repo, "cwd");
		const previous = process.cwd();
		process.chdir(record.path);
		try {
			expect(await cleanupCreatedWorktree(record)).toBeUndefined();
			expect(process.cwd()).toBe(repo);
			expect(existsSync(record.path)).toBe(false);
		} finally {
			process.chdir(previous);
		}
	});

	it("removes a clean worktree and its branch", async () => {
		const { record } = await createWorktree(repo, "clean");
		writeFileSync(join(record.path, "loose.txt"), "ignored files do not count\n");

		expect(await cleanupCreatedWorktree(record)).toBeUndefined();
		expect(existsSync(record.path)).toBe(false);
		expect(git(repo, "branch", "--list", "pi/clean")).toBe("");
		expect(createdWorktrees.has(record.path)).toBe(false);
	});

	it("keeps a worktree with uncommitted changes", async () => {
		const { record } = await createWorktree(repo, "dirty");
		writeFileSync(join(record.path, "tracked.txt"), "changed\n");

		expect(await cleanupCreatedWorktree(record)).toContain("Worktree kept");
		expect(existsSync(record.path)).toBe(true);
	});

	it("keeps a worktree with new commits, also after switching branches", async () => {
		const { record } = await createWorktree(repo, "commits");
		writeFileSync(join(record.path, "new.txt"), "new\n");
		git(record.path, "add", "new.txt");
		git(record.path, "commit", "-q", "-m", "new");
		git(record.path, "checkout", "-q", "--detach", record.baseSha);

		expect(await cleanupCreatedWorktree(record)).toContain("Worktree kept");
		expect(git(repo, "branch", "--list", "pi/commits")).toContain("pi/commits");
	});
});
