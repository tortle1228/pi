/**
 * tmux backend of the terminal tool: one tmux session (`pi-<id>`) on the default server per pi session, so the user can
 * `tmux attach -t pi-<id>` and watch. Windows the tool opens carry `@pi-opener agent`; others are the user's.
 */

import { basename } from "node:path";
import { execText, type TerminalBackend, trimBlankLines, type WindowInfo } from "./tool.ts";

const FORMAT = [
	"#{window_id}",
	"#{window_index}",
	"#{window_name}",
	"#{pane_current_path}",
	"#{@pi-opener}",
	"#{pane_dead}",
	"#{pane_dead_status}",
	"#{pane_current_command}",
	"#{alternate_on}",
].join("\t");

export class TmuxBackend implements TerminalBackend {
	readonly kind = "tmux";
	private readonly session: string;
	private shell: Promise<string> | undefined;

	constructor(session: string) {
		this.session = session;
	}

	private tmux(args: string[], signal?: AbortSignal): Promise<string> {
		// -u: without a UTF-8 locale (LC_ALL=C) tmux prints the tabs in FORMAT as "_".
		return execText("tmux", ["-u", ...args], signal);
	}

	private async hasSession(signal?: AbortSignal): Promise<boolean> {
		return this.tmux(["has-session", "-t", this.session], signal).then(
			() => true,
			() => false,
		);
	}

	/** Target of a window by number, name, or id (`@3`). */
	private target(target: string): string {
		return target.startsWith("@") ? target : `${this.session}:${target}`;
	}

	private async parse(line: string, signal?: AbortSignal): Promise<WindowInfo & { alternate: boolean }> {
		const [id, index, name, cwd, opener, dead, deadStatus, command, alternate] = line.split("\t");
		this.shell ??= this.tmux(["show-options", "-gv", "default-shell"], signal).then((shell) =>
			basename(shell.trim()),
		);
		const shell = await this.shell;
		const running = dead !== "1";
		return {
			window: Number(index),
			id,
			...(name ? { name } : {}),
			cwd,
			opener: opener === "agent" ? "agent" : "user",
			running,
			...(!running && deadStatus !== "" ? { exitCode: Number(deadStatus) } : {}),
			...(running && command && command !== shell ? { foreground: command } : {}),
			alternate: alternate === "1",
		};
	}

	async open(options: { name?: string; cwd: string }, signal?: AbortSignal): Promise<WindowInfo> {
		if (!(await this.hasSession(signal))) {
			// A placeholder window holds the session while its options are set, so every real window gets them.
			await this.tmux(["new-session", "-d", "-s", this.session, "-x", "200", "-y", "50"], signal);
			for (const [option, value] of [
				["base-index", "1"],
				["history-limit", "10000"],
			]) {
				await this.tmux(["set-option", "-t", this.session, option, value], signal);
			}
			const placeholder = (
				await this.tmux(["list-windows", "-t", this.session, "-F", "#{window_id}"], signal)
			).trim();
			const id = await this.newWindow(options, signal);
			await this.tmux(["kill-window", "-t", placeholder], signal);
			return this.resolve(id, signal);
		}
		return this.resolve(await this.newWindow(options, signal), signal);
	}

	private async newWindow(options: { name?: string; cwd: string }, signal?: AbortSignal): Promise<string> {
		const id = (
			await this.tmux(
				[
					"new-window",
					"-d",
					"-t",
					`${this.session}:`,
					"-c",
					options.cwd,
					...(options.name ? ["-n", options.name] : []),
					"-P",
					"-F",
					"#{window_id}",
				],
				signal,
			)
		).trim();
		// Keep an exited window so its output and exit code stay readable.
		await this.tmux(["set-option", "-w", "-t", id, "remain-on-exit", "on"], signal);
		await this.tmux(["set-option", "-w", "-t", id, "@pi-opener", "agent"], signal);
		return id;
	}

	async list(signal?: AbortSignal): Promise<WindowInfo[]> {
		if (!(await this.hasSession(signal))) return [];
		const out = await this.tmux(["list-windows", "-t", this.session, "-F", FORMAT], signal);
		return Promise.all(
			out
				.split("\n")
				.filter(Boolean)
				.map((line) => this.parse(line, signal)),
		);
	}

	async resolve(target: string, signal?: AbortSignal): Promise<WindowInfo & { alternate: boolean }> {
		if (!target.startsWith("@") && !(await this.hasSession(signal))) throw new Error(`can't find window: ${target}`);
		const line = await this.tmux(["display-message", "-p", "-t", this.target(target), FORMAT], signal);
		return this.parse(line.replace(/\n$/, ""), signal);
	}

	async send(window: WindowInfo, keys: string[], literal: boolean, signal?: AbortSignal): Promise<void> {
		await this.tmux(["send-keys", "-t", window.id, ...(literal ? ["-l"] : []), "--", ...keys], signal);
	}

	async history(window: WindowInfo, signal?: AbortSignal): Promise<{ text: string; screen: boolean }> {
		const { alternate } = await this.resolve(window.id, signal);
		const text = await this.tmux(
			["capture-pane", "-p", "-t", window.id, ...(alternate ? [] : ["-J", "-S", "-"])],
			signal,
		);
		return { text: trimBlankLines(text), screen: alternate };
	}

	async capture(window: WindowInfo, scrollback: number, escapes: boolean, signal?: AbortSignal): Promise<string> {
		const text = await this.tmux(
			[
				"capture-pane",
				"-p",
				"-t",
				window.id,
				...(escapes ? ["-e"] : []),
				...(scrollback ? ["-S", String(-scrollback)] : []),
			],
			signal,
		);
		return trimBlankLines(text);
	}

	async kill(window: WindowInfo, signal?: AbortSignal): Promise<void> {
		await this.tmux(["kill-window", "-t", window.id], signal);
	}

	async dispose(): Promise<void> {
		await this.tmux(["kill-session", "-t", this.session]).catch(() => {});
	}
}
