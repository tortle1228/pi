// Share Claude Code's project auto memory with pi through the system prompt and pi's own file tools.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

const SECTION = "claude-memory";
const MAX_LINES = 200;
const MAX_CHARS = 25_000;
const MAX_PROJECT_KEY = 200;

const READ_GUIDE = `This is background context shared with Claude Code, and it may be out of date. Read relevant topic files in this directory with the read tool. Verify any file, function, or flag a memory names before relying on it.`;

const WRITE_GUIDE = `Save a memory when the user asks, or when you learn a user preference, feedback on how to work, project context, or an external reference that will still help in later sessions. Do not save what the code, git history, or CLAUDE.md already records, or what only matters to this conversation.

Before saving, check the existing files: update a matching memory instead of duplicating it, and fix or remove one that turns out to be wrong. Keep one memory per file, starting with this frontmatter:

---
name: short-kebab-case-slug
description: one-line summary
metadata:
  type: user | feedback | project | reference
---

Keep one line per memory in MEMORY.md, in the form \`- [Title](file.md) — hook\`, and never put memory content there. Do not touch .consolidate-lock or write memory files outside this directory.`;

/** Match Claude Code's memory location: worktrees and subdirectories share the main repository's memory. */
async function projectRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const args = ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"];
	const { code, stdout } = await pi.exec("git", args, { cwd, timeout: 5_000 });
	const [commonDir, topLevel] = stdout.trim().split("\n");
	if (code !== 0 || !commonDir) return cwd;
	return basename(commonDir) === ".git" ? dirname(commonDir) : (topLevel ?? cwd);
}

async function autoMemoryEnabled(configDir: string, root: string, cwd: string): Promise<boolean> {
	const override = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY?.trim().toLowerCase() ?? "";
	if (["1", "true", "yes", "on"].includes(override)) return false;
	if (["0", "false", "no", "off"].includes(override)) return true;
	let enabled = true;
	const files = [
		join(configDir, "settings.json"),
		join(root, ".claude/settings.json"),
		// Claude Code reads project settings from cwd, so a linked worktree can differ from the main repository.
		join(cwd, ".claude/settings.json"),
		join(root, ".claude/settings.local.json"),
	];
	for (const file of files) {
		try {
			const value: unknown = JSON.parse(await readFile(file, "utf8")).autoMemoryEnabled;
			if (typeof value === "boolean") enabled = value;
		} catch {
			// Missing or malformed settings leave the previous scope's value in place.
		}
	}
	return enabled;
}

async function readIndex(directory: string): Promise<string> {
	try {
		return (await readFile(join(directory, "MEMORY.md"), "utf8")).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

/** Apply Claude Code's session-start limits; it counts characters, not bytes, so Korean text is not cut early. */
function truncateIndex(index: string): { text: string; truncated: boolean } {
	const text = index.split("\n").slice(0, MAX_LINES).join("\n");
	if (text.length <= MAX_CHARS) return { text, truncated: text !== index };
	const lineEnd = text.lastIndexOf("\n", MAX_CHARS);
	return { text: text.slice(0, lineEnd > 0 ? lineEnd : MAX_CHARS), truncated: true };
}

export default function claudeMemory(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const { sections, selectedTools } = event.systemPromptOptions;
		const root = await projectRoot(pi, ctx.cwd);
		// An empty value must not turn this into a path relative to the project.
		const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
		if (!(await autoMemoryEnabled(configDir, root, ctx.cwd))) return;

		// shortcut: rule read from the Claude Code 2.1.319 binary, not its docs; recheck if memory stops being shared.
		const projectKey = root.replace(/[^a-zA-Z0-9]/g, "-");
		// Longer keys get a private hash in Claude Code; saving under a guessed name would orphan the memory.
		if (projectKey.length > MAX_PROJECT_KEY) return;
		const directory = join(configDir, "projects", projectKey, "memory");

		const index = await readIndex(directory);
		const canWrite = selectedTools.includes("write");
		if (!index && !canWrite) return;

		const { text, truncated } = truncateIndex(index);
		sections[SECTION] = [
			`Claude Code auto memory directory: ${directory}`,
			READ_GUIDE,
			canWrite ? WRITE_GUIDE : undefined,
			text ? `Contents of MEMORY.md:\n\n${text}` : "MEMORY.md is empty or does not exist yet.",
			truncated
				? `MEMORY.md exceeds the ${MAX_LINES}-line or ${MAX_CHARS}-character limit, so the rest was not loaded. Read the file for the remainder${canWrite ? ", and shorten the index when you next edit it" : ""}.`
				: undefined,
		]
			.filter(Boolean)
			.join("\n\n");
	});
}
