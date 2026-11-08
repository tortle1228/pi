// Plan mode behavior: tool restrictions, the Plan Mode instructions, and the menu after a proposed plan.
import type { AgentMode } from "../../core/agent-mode.ts";
import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { toSafeCommand } from "./bash-policy.ts";
import { PlanMenu, type PlanMenuChoice } from "./plan-menu.ts";
import { PLAN_MODE_BASH_NOTES, PLAN_MODE_BASH_NOTES_UNRESTRICTED, PLAN_MODE_INSTRUCTIONS } from "./prompt.ts";
import { extractProposedPlan, renderProposedPlanMarkdown } from "./proposed-plan.ts";

const INSPECTION_TOOLS = new Set([
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"request_user_input",
	"web_search",
	"web_fetch",
	"web_research",
	"x_search",
	"tool_search",
]);
const NEVER_READ_ONLY = new Set(["edit", "write", "powershell", "codemode", "todo", "tasks"]);
const ALLOW = "Allow";

const TOOLS_ENTRY = "plan-mode-tools";
// Entries of the retired pi-extensions plan-mode package, read so its sessions get their tools back.
const LEGACY_ENTRY = "plan-mode";
const MODE_NOTICE = "plan-mode-notice";
const FRESH_IMPLEMENT_ARG = "__implement-fresh";

const NOTICES: Record<AgentMode, string> = {
	plan: "Plan mode is now active. The Plan Mode instructions apply until a later message says the mode ended.",
	build: "Plan mode has ended and you are now in Build mode. Earlier Plan Mode restrictions no longer apply, so you may edit files and run commands to do the work the user asks for.",
};

function lastAssistantText(branch: readonly SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	}
	return undefined;
}

interface NoticeDetails {
	mode: string;
	/** The bash approval the Plan instructions describe. Build notices have none. */
	bashApproval?: string;
}

/** What the model was last told, from the entries it still sees, so a notice compaction removed is sent again. */
function lastNotice(contextEntries: readonly SessionEntry[]): NoticeDetails {
	for (let i = contextEntries.length - 1; i >= 0; i--) {
		const entry = contextEntries[i];
		if (entry.type === "custom_message" && entry.customType === MODE_NOTICE) return entry.details as NoticeDetails;
	}
	return { mode: "build" };
}

/** Tools changed for Plan mode, so leaving it can undo exactly that. */
interface ToolChanges {
	/** Active tools Plan mode deactivated. */
	suppressed: string[];
	/** Tools only Plan mode activated. */
	added: string[];
}

function loadToolChanges(branch: readonly SessionEntry[]): ToolChanges {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom") continue;
		if (entry.customType === TOOLS_ENTRY) return entry.data as ToolChanges;
		if (entry.customType === LEGACY_ENTRY) {
			return { suppressed: (entry.data as { suppressedTools?: string[] }).suppressedTools ?? [], added: [] };
		}
	}
	return { suppressed: [], added: [] };
}

export default function planMode(pi: ExtensionAPI): void {
	let toolChanges: ToolChanges = { suppressed: [], added: [] };
	let planForFreshSession: string | undefined;
	let closeMenu: (() => void) | undefined;
	// Read once per user prompt, not per tool call, because getSettings() copies every setting.
	let bashApproval: "ask" | "allow" = "ask";

	pi.registerFlag("plan-readonly-tools", {
		description: "Comma-separated exact names of additional verified read-only tools",
		type: "string",
		default: "",
	});
	pi.registerMarkdownTransformer(renderProposedPlanMarkdown, { messageTypes: ["assistant"] });

	const extraReadOnlyTools = () =>
		String(pi.getFlag("plan-readonly-tools") ?? "")
			.split(",")
			.map((name) => name.trim());

	function allowed(name: string): boolean {
		if (NEVER_READ_ONLY.has(name)) return false;
		if (INSPECTION_TOOLS.has(name)) return true;
		const tool = pi.getAllTools().find((candidate) => candidate.name === name);
		if (!tool || tool.reachesTools) return false;
		return extraReadOnlyTools().includes(name) || tool.annotations?.readOnlyHint === true;
	}

	function saveToolChanges(next: ToolChanges): void {
		toolChanges = next;
		pi.appendEntry(TOOLS_ENTRY, toolChanges);
	}

	// Plan mode keeps the declared tool list unchanged, because a changed list invalidates the prompt cache.
	// The tool_call handler blocks what Plan mode forbids. This only restores tools that an older Plan mode suppressed.
	function syncTools(): void {
		const { suppressed, added } = toolChanges;
		if (pi.getMode() === "plan" || (suppressed.length === 0 && added.length === 0)) return;
		pi.setActiveTools([...new Set([...pi.getActiveTools().filter((name) => !added.includes(name)), ...suppressed])]);
		saveToolChanges({ suppressed: [], added: [] });
	}

	function load(ctx: ExtensionContext): void {
		toolChanges = loadToolChanges(ctx.sessionManager.getBranch());
		syncTools();
	}

	async function showMenu(plan: string, ctx: ExtensionContext): Promise<void> {
		const choice = await ctx.ui.custom<PlanMenuChoice>(
			(tui, theme, keybindings, done) => {
				closeMenu = () => done("stay");
				return new PlanMenu(ctx.getContextUsage()?.percent, theme, keybindings, () => tui.requestRender(), done);
			},
			{ blocked: { kind: "question", message: "Implement this plan?" } },
		);
		closeMenu = undefined;
		if (choice === "implement") {
			await pi.setMode("build");
			pi.sendUserMessage("Implement the plan.");
		} else if (choice === "implement-fresh") {
			// Replacing the session needs a command context, which event handlers do not have.
			planForFreshSession = plan;
			pi.sendUserMessage(`/plan ${FRESH_IMPLEMENT_ARG}`, { expandPromptTemplates: true });
		}
	}

	pi.registerCommand("plan", {
		description: "Enter Plan mode, or leave it with /plan off",
		handler: async (args, ctx) => {
			if (args.trim() === FRESH_IMPLEMENT_ARG && planForFreshSession !== undefined) {
				const plan = planForFreshSession;
				planForFreshSession = undefined;
				await ctx.newSession({
					parentSession: ctx.sessionManager.getSessionFile(),
					withSession: async (session) => {
						await session.sendUserMessage(`Implement the following plan:\n\n${plan}`);
					},
				});
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Stop the current run before switching modes", "warning");
				return;
			}
			await pi.setMode(args.trim() === "off" ? "build" : "plan");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (pi.getMode() !== "plan") return;
		if (!allowed(event.toolName)) {
			return {
				block: true,
				reason:
					"Plan mode: only verified inspection tools are allowed. Do not retry this tool; include the action as a step in the plan instead.",
			};
		}
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			const safeCommand = toSafeCommand(command);
			if (safeCommand !== undefined) {
				event.input.command = safeCommand;
				return;
			}
			if (bashApproval === "allow") return;
			if (ctx.mode !== "tui") {
				return {
					block: true,
					reason:
						"Plan mode: this command is not a known inspection command and no one can approve it here. Use read-only commands without writes or shell expansion.",
				};
			}
			// The user decides from this text, so the model's command must not be able to hide or reorder any of it.
			const shownCommand = command.replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, "�");
			const choice = await ctx.ui.select(`Plan mode: allow this command?\n\n${shownCommand}`, [ALLOW, "Deny"]);
			if (choice !== ALLOW) {
				return { block: true, reason: "Plan mode: the user denied this command. Do not retry it." };
			}
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		bashApproval = pi.getSettings().plan?.bashApproval ?? "ask";
		const mode = pi.getMode();
		const details: NoticeDetails = mode === "plan" ? { mode, bashApproval } : { mode };
		const last = lastNotice(ctx.sessionManager.buildContextEntries());
		if (last.mode === details.mode && last.bashApproval === details.bashApproval) return;
		// The instructions ride in the stored notice, not in a per-request message, so the cached prefix stays stable.
		const content =
			mode === "plan"
				? `${NOTICES.plan}\n\n${PLAN_MODE_INSTRUCTIONS}\n\n${bashApproval === "allow" ? PLAN_MODE_BASH_NOTES_UNRESTRICTED : PLAN_MODE_BASH_NOTES}`
				: NOTICES[mode];
		return { message: { customType: MODE_NOTICE, content, display: false, details } };
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted || pi.getMode() !== "plan" || ctx.mode !== "tui" || ctx.hasPendingMessages()) return;
		const plan = extractProposedPlan(lastAssistantText(ctx.sessionManager.getBranch()) ?? "");
		if (plan !== undefined) await showMenu(plan, ctx);
	});

	pi.on("mode_select", async () => syncTools());
	pi.on("session_start", async (_event, ctx) => {
		load(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => load(ctx));
	pi.on("session_shutdown", async () => closeMenu?.());
}
