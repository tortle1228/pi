/**
 * The `terminal` tool: tmux commands as argv on terminals the user can watch, ported from P2's terminal tool. A backend
 * (tmux or herdr-core) runs the terminals; this file parses commands, waits for output, and formats results.
 */

import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { parseCommand, type TerminalCommand, type WaitFor, type WaitOptions } from "./commands.ts";

export const TERMINAL_TOOL_NAME = "terminal";

/** A terminal window as the backend reports it. */
export interface WindowInfo {
	/** Number of the window in this session (1, 2, ...). */
	window: number;
	/** Backend id that stays the same while the window lives (tmux `@3`, herdr `t4b`). */
	id: string;
	name?: string;
	cwd: string;
	opener: "agent" | "user";
	running: boolean;
	exitCode?: number;
	/** The program in the foreground, when it is not the shell. */
	foreground?: string;
}

export interface TerminalBackend {
	readonly kind: "tmux" | "herdr";
	open(options: { name?: string; cwd: string }, signal?: AbortSignal): Promise<WindowInfo>;
	list(signal?: AbortSignal): Promise<WindowInfo[]>;
	/** A window by number, name or id; throws when there is none. */
	resolve(target: string, signal?: AbortSignal): Promise<WindowInfo>;
	/** tmux key names and text, as `send-keys` takes them. */
	send(window: WindowInfo, keys: string[], literal: boolean, signal?: AbortSignal): Promise<void>;
	/** Scrollback plus screen as plain text, or only the screen of a full-screen program (`screen: true`). */
	history(window: WindowInfo, signal?: AbortSignal): Promise<{ text: string; screen: boolean }>;
	capture(window: WindowInfo, scrollback: number, escapes: boolean, signal?: AbortSignal): Promise<string>;
	kill(window: WindowInfo, signal?: AbortSignal): Promise<void>;
	/** Ends every window of this session. */
	dispose(): Promise<void>;
}

/** Runs a backend's CLI and returns its stdout; fails with its stderr. */
export function execText(file: string, args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(file, args, { signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${file} ${args[0]}: ${stderr.trim() || error.message}`));
			else resolvePromise(stdout);
		});
	});
}

/** Text without the blank lines below it; the last line keeps its trailing spaces, as a prompt such as `>>> ` has. */
export function trimBlankLines(text: string): string {
	return text.replace(/(\n[ \t]*)+$/, "");
}

/** Characters of output a call returns at most: the last ones. */
const OUTPUT_CHARS = 16 * 1024;
/** Timeouts of waits by default, in seconds: send-keys returns sooner, its program usually answers at once. */
const DEFAULT_TIMEOUT_S = 10;
const SEND_TIMEOUT_S = 5;
const QUIET_MS = 500;
const POLL_MS = 100;

const DESCRIPTION = `Use terminals the user can watch (a tmux session or herdr terminals), like tmux. Only when the user asks for a terminal, or to drive an interactive program in one; never instead of bash.
Call it with { command, args }, args being tmux's argv after the command name (no quoting). Windows are numbered per session (1, 2, ...); -t takes a number or a name.
- new-window [-n name] [-c dir] [-w W] [-T s] [command ...]: a shell at your cwd (-c: relative to it); command is typed into it, then Enter.
- list-windows
- send-keys -t T [-l] [-w W] [-T s] key ...: tmux key names (Enter, C-c, Up, Escape, Tab, BSpace, M-x, F1) are keys, other args text; -l: all text.
- read -t T [-w W] [-T s]: output since your last read.
- capture-pane -t T [-S -N] [-e]: the screen, plus N scrollback lines; -e keeps colors.
- kill-window -t T
new-window, send-keys and read return the output since your last read of that window, after waiting: W is quiet (0.5 s without output; the default of new-window and send-keys), exit, /regex/ or none (read's default); -T is the timeout in seconds (default 10, send-keys 5, max 120). A timeout is no error.
herdr terminals paste text followed by Enter and may not deliver keys to full-screen programs such as vim; if keys do not take effect there, say so and suggest putting "tmux" first in the terminalTool.backends setting instead of retrying.
Example: { "command": "new-window", "args": ["-n", "dev", "npm run dev"] }, then { "command": "send-keys", "args": ["-t", "dev", "C-c"] }.`;

const terminalSchema = Type.Object({
	command: Type.Union(
		[
			Type.Literal("new-window"),
			Type.Literal("list-windows"),
			Type.Literal("send-keys"),
			Type.Literal("read"),
			Type.Literal("capture-pane"),
			Type.Literal("kill-window"),
		],
		{ description: "tmux command" },
	),
	args: Type.Optional(
		Type.Array(Type.String(), { description: "tmux's arguments after the command name, one per element." }),
	),
});

export type TerminalToolInput = Static<typeof terminalSchema>;

/** One shape for every command, its fields as they apply. */
export interface TerminalResult {
	window?: number;
	output?: string;
	running?: boolean;
	foreground?: string;
	exitCode?: number;
	screen?: boolean;
	skipped?: number;
	timedOut?: boolean;
	killed?: boolean;
	windows?: Array<{
		window: number;
		name?: string;
		location: string;
		opener: "agent" | "user";
		running: boolean;
		foreground?: string;
		exitCode?: number;
	}>;
}

export interface TerminalToolOptions {
	/** The session's backend, created on first use. */
	getBackend: (sessionId: string) => TerminalBackend;
}

export function createTerminalToolDefinition(
	options: TerminalToolOptions,
): ToolDefinition<typeof terminalSchema, TerminalResult> {
	// What each window printed at the last read, by window id: the read cursor.
	const lastRead = new Map<string, string>();
	return {
		name: TERMINAL_TOOL_NAME,
		label: "terminal",
		description: DESCRIPTION,
		promptSnippet: "Drive interactive programs in terminals the user can watch (tmux-style commands)",
		parameters: terminalSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// A CommandError (a command line tmux would refuse) becomes the tool's error result.
			const command = parseCommand(params.command, params.args ?? []);
			const result = await run(
				command,
				options.getBackend(ctx.sessionManager.getSessionId()),
				lastRead,
				ctx.cwd,
				signal,
			);
			return { content: [{ type: "text", text: describe(result) }], details: result };
		},
	};
}

async function run(
	command: TerminalCommand,
	backend: TerminalBackend,
	lastRead: Map<string, string>,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<TerminalResult> {
	switch (command.command) {
		case "new-window": {
			const directory = command.directory;
			const window = await backend.open(
				{
					...(command.name ? { name: command.name } : {}),
					cwd: directory === undefined ? cwd : isAbsolute(directory) ? directory : resolve(cwd, directory),
				},
				signal,
			);
			lastRead.set(window.id, "");
			if (command.shellCommand) {
				// Type once the shell has drawn its prompt: typed ahead, the command interleaves with the shell's startup output.
				const quiet: Wait = { wait: { kind: "quiet" }, timeoutMs: DEFAULT_TIMEOUT_S * 1000 };
				await read(backend, window, lastRead, quiet, signal, true);
				lastRead.set(window.id, "");
				await backend.send(window, [command.shellCommand, "Enter"], false, signal);
			}
			return read(backend, window, lastRead, waitOf(command, { kind: "quiet" }, DEFAULT_TIMEOUT_S), signal);
		}
		case "list-windows": {
			const windows = await backend.list(signal);
			return {
				windows: windows.map((window) => ({
					window: window.window,
					...(window.name ? { name: window.name } : {}),
					location: window.cwd,
					opener: window.opener,
					running: window.running,
					...(window.foreground ? { foreground: window.foreground } : {}),
					...(window.exitCode === undefined ? {} : { exitCode: window.exitCode }),
				})),
			};
		}
		case "send-keys": {
			const window = await backend.resolve(command.target, signal);
			if (!window.running) throw new Error(`window ${window.window} has exited`);
			await backend.send(window, command.keys, command.literal, signal);
			return read(backend, window, lastRead, waitOf(command, { kind: "quiet" }, SEND_TIMEOUT_S), signal);
		}
		case "read": {
			const window = await backend.resolve(command.target, signal);
			return read(backend, window, lastRead, waitOf(command, { kind: "none" }, DEFAULT_TIMEOUT_S), signal);
		}
		case "capture-pane": {
			const window = await backend.resolve(command.target, signal);
			const text = await backend.capture(window, command.scrollback, command.escapes, signal);
			return { ...stateOf(window), ...cut(text, 0) };
		}
		case "kill-window": {
			const window = await backend.resolve(command.target, signal);
			await backend.kill(window, signal);
			lastRead.delete(window.id);
			return { window: window.window, killed: true };
		}
	}
}

export type Wait = { wait: WaitFor; timeoutMs: number };

/** The wait a command asks for, or its default. */
function waitOf(options: WaitOptions, fallback: WaitFor, timeoutS: number): Wait {
	return { wait: options.wait ?? fallback, timeoutMs: Math.round((options.timeout ?? timeoutS) * 1000) };
}

/** Output since the last read. shortcut: when the history no longer starts with the last read (scrollback trimmed, screen redrawn), returns the whole history; track a byte stream if that proves noisy. */
export function newOutput(previous: string, text: string): string {
	return text.startsWith(previous) ? text.slice(previous.length).replace(/^\n/, "") : text;
}

/** Waits as asked, then returns the output since the window's last read and moves the read cursor. */
async function read(
	backend: TerminalBackend,
	window: WindowInfo,
	lastRead: Map<string, string>,
	{ wait, timeoutMs }: Wait,
	signal: AbortSignal | undefined,
	/** A quiet wait first waits for some output. */
	needOutput = false,
): Promise<TerminalResult> {
	const previous = lastRead.get(window.id) ?? "";
	const pattern = wait.kind === "match" ? new RegExp(wait.pattern, wait.ignoreCase ? "i" : "") : undefined;
	const deadline = Date.now() + timeoutMs;
	let info = window;
	let snapshot = await backend.history(info, signal);
	let changedAt = Date.now();
	let timedOut = false;
	while (wait.kind !== "none") {
		// A wait also ends when the program exits.
		if (!info.running) break;
		if (pattern?.test(newOutput(previous, snapshot.text))) break;
		if (wait.kind === "quiet" && Date.now() - changedAt >= QUIET_MS && (!needOutput || snapshot.text !== previous))
			break;
		if (Date.now() >= deadline) {
			timedOut = true;
			break;
		}
		await sleep(POLL_MS, signal);
		info = await backend.resolve(window.id, signal);
		const next = await backend.history(info, signal);
		if (next.text !== snapshot.text) changedAt = Date.now();
		snapshot = next;
	}
	if (wait.kind === "none") info = await backend.resolve(window.id, signal);
	lastRead.set(window.id, snapshot.text);
	const output = snapshot.screen ? snapshot.text : newOutput(previous, snapshot.text);
	return {
		...stateOf(info),
		...cut(output, 0),
		...(snapshot.screen ? { screen: true } : {}),
		...(timedOut ? { timedOut: true } : {}),
	};
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) return reject(new Error("Aborted"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** The output's last `OUTPUT_CHARS`, with what was left out before it counted in `skipped`. */
function cut(text: string, skipped: number): { output: string; skipped?: number } {
	const over = Math.max(0, text.length - OUTPUT_CHARS);
	const total = skipped + over;
	return { output: over ? text.slice(over) : text, ...(total ? { skipped: total } : {}) };
}

function stateOf(window: WindowInfo): TerminalResult {
	return {
		window: window.window,
		running: window.running,
		...(window.foreground ? { foreground: window.foreground } : {}),
		...(window.exitCode === undefined ? {} : { exitCode: window.exitCode }),
	};
}

/** The result as the model reads it. */
export function describe(result: TerminalResult): string {
	if (result.windows)
		return result.windows.length === 0
			? "No windows."
			: result.windows
					.map(
						(window) =>
							`${window.window}: ${[
								window.name ?? "",
								window.location,
								`opened by ${window.opener}`,
								status(window),
							]
								.filter(Boolean)
								.join(" · ")}`,
					)
					.join("\n");
	if (result.killed) return `Killed window ${result.window}.`;
	const lines = [`window ${result.window} · ${status(result)}${result.screen ? " · full-screen program" : ""}`];
	if (result.skipped) lines.push(`… ${result.skipped} characters skipped`);
	if (result.output) lines.push(result.output);
	if (result.timedOut && result.running)
		lines.push(`(timed out: still running${result.foreground ? ` (foreground: ${result.foreground})` : ""})`);
	return lines.join("\n");
}

function status(result: Pick<TerminalResult, "running" | "foreground" | "exitCode">): string {
	if (result.running) return result.foreground ? `running ${result.foreground}` : "at the prompt";
	return `exited${result.exitCode === undefined ? "" : ` with code ${result.exitCode}`}`;
}
