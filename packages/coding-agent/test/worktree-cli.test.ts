import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-cli-")));
	tempDirs.push(root);
	const repo = join(root, "repo");
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	execFileSync(
		"git",
		["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
		{
			cwd: repo,
		},
	);
	return { root, repo, agentDir: join(root, "agent"), trace: join(root, "git-trace.log") };
}

function runCli(args: string[], dirs: ReturnType<typeof setup>): Promise<{ code: number | null; stderr: string }> {
	let stderr = "";
	const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
		cwd: dirs.repo,
		env: { ...process.env, [ENV_AGENT_DIR]: dirs.agentDir, PI_OFFLINE: "1", GIT_TRACE: dirs.trace },
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ code, stderr });
		});
	});
}

describe("--worktree", () => {
	it("rejects session selection flags before creating anything", async () => {
		const dirs = setup();
		const result = await runCli(["-w", "feat", "--continue", "-p", "hi"], dirs);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--worktree cannot be combined with --continue");
		expect(existsSync(join(dirs.agentDir, "worktrees"))).toBe(false);
	});

	it("creates the worktree at startup and removes it on exit when unchanged", async () => {
		const dirs = setup();
		await runCli(["-w", "feat", "--no-session", "-p", "hi"], dirs);
		const trace = readFileSync(dirs.trace, "utf8");
		expect(trace).toMatch(/git worktree add -b pi\/feat \S+[\\/]worktrees[\\/]repo-[0-9a-f]{8}[\\/]feat /);
		expect(trace).toMatch(/git worktree remove \S+[\\/]feat/);
		expect(trace).toContain("git branch -D pi/feat");
		expect(
			execFileSync("git", ["worktree", "list"], { cwd: dirs.repo, encoding: "utf8" }).trim().split("\n"),
		).toHaveLength(1);
	});

	it("fails outside a git repository", async () => {
		const dirs = setup();
		rmSync(join(dirs.repo, ".git"), { recursive: true, force: true });
		const result = await runCli(["-w", "-p", "hi"], dirs);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--worktree: Not inside a git repository");
	});
});
