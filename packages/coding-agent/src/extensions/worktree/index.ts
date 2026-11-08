// Git worktrees for isolated work: the `/worktree` command, the `enter_worktree` tool, and cleanup on quit.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { SessionManager } from "../../core/session-manager.ts";
import {
	cleanupCreatedWorktree,
	createdWorktrees,
	createWorktree,
	listWorktreePaths,
	randomWorktreeName,
	resolveRepo,
	validateWorktreeName,
	type WorktreeRecord,
	worktreesRoot,
} from "../../core/worktree.ts";

/** Internal argument the tool uses to re-enter the command; the name pattern cannot produce it. */
const ENTER_PENDING_ARG = "__enter-pending";
const WORKTREE_MESSAGE_TYPE = "worktree";

const EnterWorktreeParams = Type.Object({
	name: Type.Optional(
		Type.String({
			description: "Worktree and branch name (pi/<name>). Letters, digits, '.', '_', '-'. Omit for a random name.",
		}),
	),
});

interface Target {
	path: string;
	branch: string;
	repoRoot: string;
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true, details: undefined };
}

/** Move the conversation into a session whose cwd is the worktree, then switch to it. */
async function enterWorktree(ctx: ExtensionCommandContext, target: Target, triggerTurn: boolean): Promise<void> {
	const currentFile = ctx.sessionManager.getSessionFile();
	if (!currentFile) {
		ctx.ui.notify("Worktrees need a saved session (not --no-session).", "error");
		return;
	}
	let targetFile: string;
	if (existsSync(currentFile)) {
		// shortcut: the fork always goes to the worktree's default session dir, ignoring --session-dir.
		const forked = SessionManager.forkFrom(currentFile, target.path);
		targetFile = forked.getSessionFile()!;
	} else {
		// Nothing was said yet, so the session file does not exist; start a new one with the worktree as cwd.
		const fresh = SessionManager.create(target.path);
		targetFile = fresh.getSessionFile()!;
		mkdirSync(dirname(targetFile), { recursive: true });
		writeFileSync(targetFile, `${JSON.stringify(fresh.getHeader())}\n`, { flag: "wx" });
	}
	await ctx.switchSession(targetFile, {
		withSession: async (session) => {
			await session.sendMessage(
				{
					customType: WORKTREE_MESSAGE_TYPE,
					content: `Working directory is now ${target.path} (branch ${target.branch}, a git worktree of ${target.repoRoot}).`,
					display: true,
					details: target,
				},
				{ triggerTurn },
			);
		},
	});
}

export default function worktree(pi: ExtensionAPI): void {
	let pending: WorktreeRecord | undefined;

	pi.registerCommand("worktree", {
		description: "Continue this session in a git worktree on branch pi/<name> (created if missing)",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === ENTER_PENDING_ARG) {
				const record = pending;
				pending = undefined;
				if (record) await enterWorktree(ctx, record, true);
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Stop the current run before switching to a worktree", "warning");
				return;
			}
			try {
				const repo = await resolveRepo(ctx.cwd);
				if (!repo) throw new Error("Not inside a git repository");
				const name = arg || randomWorktreeName();
				await validateWorktreeName(ctx.cwd, name);
				const path = join(worktreesRoot(repo.repoRoot), name);
				const realPath = existsSync(path) ? realpathSync(path) : undefined;
				const registered = await listWorktreePaths(ctx.cwd);
				if (realPath && registered.some((p) => existsSync(p) && realpathSync(p) === realPath)) {
					await enterWorktree(ctx, { path: realPath, branch: `pi/${name}`, repoRoot: repo.repoRoot }, false);
					return;
				}
				const { record, warnings } = await createWorktree(ctx.cwd, name);
				for (const warning of warnings) ctx.ui.notify(warning, "warning");
				await enterWorktree(ctx, record, false);
			} catch (error) {
				ctx.ui.notify(`worktree: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerTool<typeof EnterWorktreeParams, undefined>({
		name: "enter_worktree",
		label: "Enter worktree",
		description:
			"Create a git worktree on a new branch pi/<name> from the current HEAD, outside the repository, and continue this conversation there. The current turn ends; the session resumes in the worktree.",
		promptSnippet: "Create an isolated git worktree and continue the session in it",
		promptGuidelines: [
			"Call enter_worktree only when the user or the project instructions ask for a worktree or isolated work. Never call it when the instructions say to work in the current checkout.",
			"If it is unclear whether the user wants a worktree, ask before calling enter_worktree (with request_user_input when available).",
			"Do not call enter_worktree when already inside a linked git worktree.",
		],
		parameters: EnterWorktreeParams,
		// Off until session_start finds the interactive UI it needs for approval.
		defaultActive: false,
		// Sequential batches run each call's tool_call check after the previous call, so the block below catches later calls.
		executionMode: "sequential",

		async execute(_toolCallId, params: Static<typeof EnterWorktreeParams>, _signal, _onUpdate, ctx) {
			const repo = await resolveRepo(ctx.cwd);
			if (!repo) return errorResult("Not inside a git repository.");
			if (repo.isLinkedWorktree) {
				return errorResult("Already inside a linked git worktree. Continue here; do not create another one.");
			}
			if (!ctx.sessionManager.getSessionFile()) return errorResult("Worktrees need a saved session.");
			if (ctx.mode !== "tui") {
				return errorResult(
					"Worktree creation needs interactive approval; ask the user to run /worktree or pi --worktree.",
				);
			}
			const name = params.name ?? randomWorktreeName();
			try {
				await validateWorktreeName(ctx.cwd, name);
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
			const path = join(worktreesRoot(repo.repoRoot), name);
			const approved = await ctx.ui.confirm("Create worktree?", `${repo.repoRoot}\nbranch pi/${name}\nat ${path}`);
			if (!approved) {
				return errorResult("User declined the worktree. Continue in the current checkout; do not retry.");
			}
			try {
				const { record, warnings } = await createWorktree(ctx.cwd, name);
				pending = record;
				const notes = warnings.length > 0 ? `\n${warnings.join("\n")}` : "";
				return {
					content: [
						{
							type: "text",
							text: `Created worktree at ${record.path} on branch ${record.branch}. The session continues there.${notes}`,
						},
					],
					details: undefined,
					terminate: true,
				};
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const active = pi.getActiveTools();
		// An empty set means --no-tools; adding a tool there would override the user's choice.
		if (ctx.mode === "tui" && active.length > 0 && !active.includes("enter_worktree")) {
			pi.setActiveTools([...active, "enter_worktree"]);
		}
	});

	// Until the switch, every tool would still run in the original checkout, so later calls are blocked.
	pi.on("tool_call", () => {
		if (!pending) return;
		return {
			block: true,
			terminate: true,
			reason: "Switching to the worktree; continue there after the switch.",
		};
	});

	// Replacing the session needs a command context, which tools and event handlers do not have.
	pi.on("agent_settled", (event, ctx) => {
		if (!pending) return;
		if (event.aborted) {
			const name = pending.branch.slice("pi/".length);
			ctx.ui.notify(`Worktree created at ${pending.path}; run /worktree ${name} to enter it`, "info");
			pending = undefined;
			return;
		}
		pi.sendUserMessage(`/worktree ${ENTER_PENDING_ARG}`, { expandPromptTemplates: true });
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit") return;
		for (const record of [...createdWorktrees.values()]) {
			const message = await cleanupCreatedWorktree(record);
			if (message) process.stderr.write(`${message}\n`);
		}
	});
}
