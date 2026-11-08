/**
 * The `terminal` tool as an extension: tmux-style commands on terminals the user can watch, run by tmux or herdr-core.
 * `terminalTool.backends` orders the backends; the first available one is used. Without any, the tool is not
 * registered. A session's terminals end with it.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { HerdrBackend } from "./herdr.ts";
import { TmuxBackend } from "./tmux.ts";
import { createTerminalToolDefinition, type TerminalBackend } from "./tool.ts";

export type BackendKind = TerminalBackend["kind"];

/** The first backend of `order` that is available. */
export function pickBackend(
	order: readonly BackendKind[],
	available: Readonly<Record<BackendKind, boolean>>,
): BackendKind | undefined {
	return order.find((kind) => available[kind]);
}

/** Which backends this machine has: tmux on PATH; herdr when pi runs in an hc terminal. */
export function detectBackends(env: NodeJS.ProcessEnv = process.env): Record<BackendKind, boolean> {
	const works = (file: string, args: string[]) =>
		spawnSync(file, args, { stdio: "ignore", timeout: 5000 }).status === 0;
	return { tmux: works("tmux", ["-V"]), herdr: !!env.HC_TERMINAL_SOCKET && works("hc", ["--help"]) };
}

export function createTerminalExtension(detected?: Readonly<Record<BackendKind, boolean>>): ExtensionFactory {
	return (pi) => {
		const available = detected ?? detectBackends();
		if (!available.tmux && !available.herdr) return;
		let backend: TerminalBackend | undefined;
		pi.registerTool(
			createTerminalToolDefinition({
				getBackend: (sessionId) => {
					if (backend) return backend;
					const order = pi.getSettings().terminalTool?.backends ?? SETTINGS_DEFAULTS.terminalTool.backends;
					const kind = pickBackend(order, available);
					if (!kind)
						throw new Error(
							`No terminal backend available: terminalTool.backends is ${JSON.stringify(order)}, available: ${Object.keys(
								available,
							)
								.filter((name) => available[name as BackendKind])
								.join(", ")}`,
						);
					// The id's tail: session ids start with a timestamp, so their heads repeat between sessions.
					const session = `pi-${sessionId.replace(/-/g, "").slice(-8)}`;
					backend = kind === "tmux" ? new TmuxBackend(session) : new HerdrBackend(session);
					return backend;
				},
			}),
		);
		// Reload, new, resume, and fork replace this extension instance, so its terminals would be unreachable.
		pi.on("session_shutdown", async () => {
			await backend?.dispose();
			backend = undefined;
		});
	};
}

export default createTerminalExtension();
