// Verify memory resolution, limits, write guidance, and opt-outs against temporary directories and real git.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import claudeMemory from "../src/extensions/claude-memory/index.ts";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

/** Run the handler with real commands; the fixture implements only the host methods this extension uses. */
async function run(cwd: string, selectedTools = ["read", "write"]) {
	let handler: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
	const pi = {
		on(_event: string, registered: typeof handler) {
			handler = registered;
		},
		async exec(command: string, args: string[], { cwd: directory }: { cwd: string }) {
			try {
				const { stdout } = await exec(command, args, { cwd: directory });
				return { code: 0, stdout };
			} catch {
				return { code: 1, stdout: "" };
			}
		},
	};
	claudeMemory(pi as unknown as ExtensionAPI);
	if (!handler) throw new Error("before_agent_start was not registered");
	const sections: Record<string, string> = {};
	await handler({ systemPromptOptions: { sections, selectedTools } }, { cwd } as ExtensionContext);
	return sections["claude-memory"];
}

describe("claude memory", () => {
	let directory: string;
	let config: string;
	let project: string;
	const previous = { config: process.env.CLAUDE_CONFIG_DIR, disable: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY };

	const memoryDir = (root: string) => join(config, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
	const writeMemory = async (root: string, content: string) => {
		await mkdir(memoryDir(root), { recursive: true });
		await writeFile(join(memoryDir(root), "MEMORY.md"), content);
	};
	const writeSettings = async (root: string, name: string, enabled: boolean | string) => {
		await mkdir(root, { recursive: true });
		const text = typeof enabled === "string" ? enabled : JSON.stringify({ autoMemoryEnabled: enabled });
		await writeFile(join(root, name), text);
	};
	const addWorktree = async () => {
		const worktree = join(directory, "work/linked");
		await git(project, "init", "-q");
		const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
		await git(project, ...identity, "commit", "-q", "--allow-empty", "-m", "x");
		await git(project, "worktree", "add", "-q", worktree);
		return worktree;
	};
	const koreanBody = (section: string) => section.slice(section.indexOf("메"), section.lastIndexOf("메") + 1);

	beforeAll(async () => {
		directory = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-memory-")));
		config = join(directory, "config");
		project = join(directory, "work/my.project");
	});
	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
		for (const [name, value] of [
			["CLAUDE_CONFIG_DIR", previous.config],
			["CLAUDE_CODE_DISABLE_AUTO_MEMORY", previous.disable],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	beforeEach(async () => {
		process.env.CLAUDE_CONFIG_DIR = config;
		delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
		await mkdir(project, { recursive: true });
	});
	afterEach(async () => {
		await rm(config, { recursive: true, force: true });
		await rm(join(directory, "work"), { recursive: true, force: true });
	});

	it("encodes every non-alphanumeric path character like Claude Code", async () => {
		const section = await run(project);
		expect(section).toContain(`${config}/projects/`);
		expect(section).toContain(project.replace(/[^a-zA-Z0-9]/g, "-"));
		expect(section).toContain("-work-my-project/memory");
	});

	it("treats an empty CLAUDE_CONFIG_DIR as unset instead of a path inside the project", async () => {
		const home = process.env.HOME;
		onTestFinished(() => {
			process.env.HOME = home;
		});
		process.env.HOME = directory;
		process.env.CLAUDE_CONFIG_DIR = "";
		expect(await run(project)).toContain(`directory: ${join(directory, ".claude/projects")}/`);
	});

	it("shares one memory across a repository root, subdirectory, and worktree", async () => {
		const worktree = await addWorktree();
		const subdirectory = join(project, "nested/deeper");
		await mkdir(subdirectory, { recursive: true });
		await writeMemory(project, "- [Shared](shared.md) — repository memory");
		for (const cwd of [project, subdirectory, worktree]) {
			expect(await run(cwd), cwd).toMatch(/repository memory/);
		}
	});

	it("reads relative to cwd outside a git repository", async () => {
		await writeMemory(project, "- [Plain](plain.md) — plain directory");
		expect(await run(project)).toMatch(/plain directory/);
	});

	it("keeps exactly 200 lines without a truncation notice", async () => {
		await writeMemory(project, `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}\n`);
		const section = await run(project);
		expect(section).toMatch(/line 199/);
		expect(section).not.toMatch(/was not loaded/);
	});

	it("cuts the index at 200 lines and says so", async () => {
		await writeMemory(project, Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n"));
		const section = await run(project);
		expect(section).toMatch(/line 199/);
		expect(section).not.toMatch(/line 200/);
		expect(section).toMatch(/was not loaded/);
	});

	it("counts characters like Claude Code, so a Korean index over 25,000 bytes stays whole", async () => {
		await writeMemory(project, Array.from({ length: 120 }, () => "메".repeat(100)).join("\n"));
		const section = (await run(project)) ?? "";
		expect(section).not.toMatch(/was not loaded/);
		expect(koreanBody(section).replaceAll("\n", "")).toHaveLength(12_000);
	});

	it("cuts at 25,000 characters on a line boundary", async () => {
		await writeMemory(project, Array.from({ length: 150 }, () => "메".repeat(200)).join("\n"));
		const section = (await run(project)) ?? "";
		expect(section).toMatch(/was not loaded/);
		const body = koreanBody(section);
		expect(body.length).toBeLessThanOrEqual(25_000);
		for (const line of body.split("\n")) expect(line).toHaveLength(200);
	});

	it("cuts a single line over the limit at exactly 25,000 characters", async () => {
		await writeMemory(project, "메".repeat(30_000));
		const section = (await run(project)) ?? "";
		expect(section).toMatch(/was not loaded/);
		expect(koreanBody(section)).toHaveLength(25_000);
	});

	it("offers write guidance in Claude Code's format, even with no memory", async () => {
		const section = await run(project);
		expect(section).toContain(memoryDir(project));
		expect(section).toMatch(/Save a memory when the user asks/);
		expect(section).toMatch(/^metadata:\n {2}type: user/m);
		expect(section).not.toMatch(/^type:/m);
		expect(section).toMatch(/MEMORY\.md is empty/);
	});

	it("drops write guidance when write is inactive", async () => {
		await writeMemory(project, "- [Note](note.md) — readable");
		const section = await run(project, ["read"]);
		expect(section).toMatch(/readable/);
		expect(section).not.toMatch(/Save a memory/);
	});

	it("adds no section when write is inactive and memory is empty", async () => {
		expect(await run(project, ["read"])).toBeUndefined();
	});

	it("honors autoMemoryEnabled with project settings overriding user settings", async () => {
		await writeMemory(project, "- [Note](note.md) — visible");
		await writeSettings(config, "settings.json", false);
		expect(await run(project)).toBeUndefined();
		await writeSettings(join(project, ".claude"), "settings.json", true);
		expect(await run(project)).toMatch(/visible/);
		await writeSettings(join(project, ".claude"), "settings.local.json", false);
		expect(await run(project)).toBeUndefined();
	});

	it("honors project settings in a linked worktree without affecting the main repository", async () => {
		const worktree = await addWorktree();
		await writeMemory(project, "- [Note](note.md) — visible");
		await writeSettings(join(worktree, ".claude"), "settings.json", false);
		expect(await run(worktree)).toBeUndefined();
		expect(await run(project)).toMatch(/visible/);
	});

	it("ignores malformed settings", async () => {
		await writeMemory(project, "- [Note](note.md) — visible");
		await writeSettings(config, "settings.json", "{ not json");
		expect(await run(project)).toMatch(/visible/);
	});

	it("lets the environment variable override settings in both directions", async () => {
		await writeMemory(project, "- [Note](note.md) — visible");
		process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
		expect(await run(project)).toBeUndefined();
		await writeSettings(config, "settings.json", false);
		process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "0";
		expect(await run(project)).toMatch(/visible/);
	});

	it("skips projects whose encoded path Claude Code would hash", async () => {
		const long = join(directory, "work", "x".repeat(200));
		await mkdir(long, { recursive: true });
		expect(await run(long)).toBeUndefined();
	});
});
