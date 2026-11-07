// Plan/build mode as recorded on a session branch.
import type { SessionEntry } from "./session-manager.ts";

export type AgentMode = "build" | "plan";

/** The model and thinking level a mode last used on a branch. */
export interface ModeSelection {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
}

/** The mode a branch is in. Branches without a `mode_change` are in build mode. */
export function getBranchMode(branch: readonly SessionEntry[]): AgentMode {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "mode_change") return entry.mode;
	}
	return "build";
}

/** Replays a branch: a `model_change` or `thinking_level_change` belongs to the mode active when it was recorded. */
export function getModeSelection(branch: readonly SessionEntry[], mode: AgentMode): ModeSelection {
	const selection: ModeSelection = {};
	let current: AgentMode = "build";
	for (const entry of branch) {
		if (entry.type === "mode_change") current = entry.mode;
		else if (current !== mode) continue;
		else if (entry.type === "model_change") selection.model = { provider: entry.provider, modelId: entry.modelId };
		else if (entry.type === "thinking_level_change") selection.thinkingLevel = entry.thinkingLevel;
	}
	return selection;
}
