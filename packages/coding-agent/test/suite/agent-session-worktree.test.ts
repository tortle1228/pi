import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionMode } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createdWorktrees, worktreesRoot } from "../../src/core/worktree.ts";
import worktreeExtension from "../../src/extensions/worktree/index.ts";
import { createTestUiContext, getMessageText } from "./harness.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("worktree extension", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		createdWorktrees.clear();
	});

	async function setup(options: { confirm?: boolean; mode?: ExtensionMode } = {}) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-suite-")));
		const agentDir = join(root, "agent");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const repo = join(root, "repo");
		execFileSync("git", ["init", "-q", "-b", "main", repo]);
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, "a.txt"), "a\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");

		const faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const runtimeOptions = {
			agentDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				noExtensions: true,
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((m) => ({
								id: m.id,
								name: m.name,
								api: m.api,
								reasoning: m.reasoning,
								input: m.input,
								cost: m.cost,
								contextWindow: m.contextWindow,
								maxTokens: m.maxTokens,
							})),
						});
						worktreeExtension(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: repo,
			agentDir,
			sessionManager: SessionManager.create(repo),
		});
		const notifications: string[] = [];
		const bind = async (host: AgentSessionRuntime) => {
			await host.session.bindExtensions({
				mode: options.mode ?? "tui",
				uiContext: createTestUiContext({
					confirm: async () => options.confirm ?? true,
					notify: (message) => notifications.push(message),
				}),
				commandContextActions: {
					waitForIdle: () => host.session.waitForIdle(),
					newSession: (o) => host.newSession(o),
					fork: (entryId, o) => host.fork(entryId, o),
					navigateTree: async () => ({ cancelled: false }),
					switchSession: (path, o) => host.switchSession(path, o),
					reload: async () => {},
				},
			});
		};
		runtime.setRebindSession(async () => bind(runtime));
		await bind(runtime);

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		});
		return { runtime, faux, repo, notifications };
	}

	it("enter_worktree continues the conversation in the worktree after approval", async () => {
		const { runtime, faux, repo } = await setup();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("enter_worktree", { name: "feat" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("working in the worktree"),
		]);
		const path = join(worktreesRoot(repo), "feat");

		await runtime.session.prompt("isolate this work in a worktree");
		await vi.waitFor(() => expect(runtime.session.sessionManager.getCwd()).toBe(path));
		await vi.waitFor(() => expect(runtime.session.isStreaming).toBe(false));
		await runtime.session.waitForIdle();

		expect(runtime.cwd).toBe(path);
		expect(git(path, "branch", "--show-current")).toBe("pi/feat");
		const texts = runtime.session.messages.map(getMessageText);
		expect(texts).toContain("isolate this work in a worktree");
		expect(texts.some((t) => t.includes(`Working directory is now ${path}`))).toBe(true);
		expect(texts).toContain("working in the worktree");
	});

	it("enter_worktree does nothing when the user declines", async () => {
		const { runtime, faux, repo } = await setup({ confirm: false });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("enter_worktree", { name: "feat" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("staying"),
		]);

		await runtime.session.prompt("maybe isolate");
		await runtime.session.waitForIdle();

		expect(runtime.cwd).toBe(repo);
		expect(existsSync(join(worktreesRoot(repo), "feat"))).toBe(false);
		const result = runtime.session.messages.find((m) => m.role === "toolResult");
		expect(result && getMessageText(result)).toContain("User declined");
	});

	it("enter_worktree is only active with the interactive UI", async () => {
		const print = await setup({ mode: "print" });
		expect(print.runtime.session.getActiveToolNames()).not.toContain("enter_worktree");
		const tui = await setup();
		expect(tui.runtime.session.getActiveToolNames()).toContain("enter_worktree");
	});

	it("blocks tools after enter_worktree so they do not touch the original checkout", async () => {
		const { runtime, faux, repo } = await setup();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("enter_worktree", { name: "feat" }),
					fauxToolCall("enter_worktree", { name: "other" }),
					fauxToolCall("write", { path: "leak.txt", content: "leak\n" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("in the worktree"),
		]);
		const path = join(worktreesRoot(repo), "feat");

		await runtime.session.prompt("isolate this work");
		await vi.waitFor(() => expect(runtime.cwd).toBe(path));
		await vi.waitFor(() => expect(runtime.session.isStreaming).toBe(false));
		await runtime.session.waitForIdle();

		expect(existsSync(join(repo, "leak.txt"))).toBe(false);
		expect(existsSync(join(worktreesRoot(repo), "other"))).toBe(false);
		const blocked = runtime.session.messages.filter(
			(m) => m.role === "toolResult" && getMessageText(m).includes("Switching to the worktree"),
		);
		expect(blocked).toHaveLength(2);
	});

	it("/worktree switches cwd, and enter_worktree refuses inside a linked worktree", async () => {
		const { runtime, faux, repo } = await setup();
		const path = join(worktreesRoot(repo), "cmd");

		await runtime.session.prompt("/worktree cmd");
		expect(runtime.cwd).toBe(path);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("enter_worktree", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await runtime.session.prompt("nest");
		await runtime.session.waitForIdle();
		const result = runtime.session.messages.find((m) => m.role === "toolResult");
		expect(result && getMessageText(result)).toContain("Already inside a linked git worktree");
	});
});
