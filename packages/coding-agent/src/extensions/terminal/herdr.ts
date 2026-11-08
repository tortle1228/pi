/**
 * herdr-core backend of the terminal tool: windows are `hc` terminals started as children of pi's own terminal, so they
 * show in herdr's sidebar and end with pi. Labels tie them to this pi session (`pi.session`) and carry their number and
 * name.
 */

import { basename } from "node:path";
import { CommandError } from "./commands.ts";
import { execText, type TerminalBackend, trimBlankLines, type WindowInfo } from "./tool.ts";

/** tmux's names for keys without a character, as hc names them. */
const NAMED: Record<string, string> = {
	Enter: "enter",
	Escape: "esc",
	Tab: "tab",
	BTab: "shift+tab",
	BSpace: "backspace",
	Space: "space",
	Up: "up",
	Down: "down",
	Left: "left",
	Right: "right",
	Home: "home",
	End: "end",
	PageUp: "pageup",
	PgUp: "pageup",
	PPage: "pageup",
	PageDown: "pagedown",
	PgDn: "pagedown",
	NPage: "pagedown",
	IC: "insert",
	Insert: "insert",
	DC: "delete",
	Delete: "delete",
	...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `f${index + 1}`])),
};

/** Characters `hc keys` takes as keys (checked against hc): text without Enter can use only these. */
const TYPABLE = /^[A-Za-z0-9 \-/.,=[\];'\\`]$/;

/** The hc key a tmux key name stands for; undefined when it names no key (then it is text). */
export function hcKey(name: string): string | undefined {
	let rest = name;
	const mods: string[] = [];
	for (;;) {
		const prefix = /^([CMS])-(?=.)/.exec(rest);
		if (prefix) {
			mods.push(prefix[1] === "C" ? "ctrl" : prefix[1] === "M" ? "alt" : "shift");
			rest = rest.slice(2);
			continue;
		}
		if (rest.length === 2 && rest.startsWith("^")) {
			mods.push("ctrl");
			rest = rest.slice(1);
		}
		break;
	}
	const named = NAMED[rest];
	// A single character only names a key with a modifier: plain `a` is text.
	if (!named && ([...rest].length !== 1 || rest === name)) return undefined;
	// tmux's C-A is C-a: Ctrl ignores case.
	const key = named ?? (mods.includes("ctrl") ? rest.toLowerCase() : rest);
	return [...new Set(mods), key].join("+");
}

export type HcInput = { kind: "send"; text: string } | { kind: "keys"; keys: string[] };

/**
 * `send-keys` arguments as hc calls. hc has no way to type arbitrary text without Enter: text followed by Enter is
 * pasted with `hc send`; other text is typed key by key, so it may use only characters hc has keys for.
 */
export function hcInputs(keys: readonly string[], literal: boolean): HcInput[] {
	const inputs: HcInput[] = [];
	const pushKeys = (more: string[]) => {
		const last = inputs.at(-1);
		if (last?.kind === "keys") last.keys.push(...more);
		else if (more.length > 0) inputs.push({ kind: "keys", keys: more });
	};
	const typeText = (text: string) => {
		for (const char of text) {
			if (!TYPABLE.test(char))
				throw new CommandError(
					`send-keys: herdr can only type text followed by Enter, or letters, digits, spaces and -/.,=[];'\\\` (got ${JSON.stringify(char)})`,
				);
		}
		pushKeys([...text].map((char) => (char === " " ? "space" : char)));
	};
	let text = "";
	for (const arg of keys) {
		const key = literal ? undefined : hcKey(arg);
		if (key === undefined) {
			text += arg;
			continue;
		}
		if (key === "enter" && text) inputs.push({ kind: "send", text });
		else {
			typeText(text);
			pushKeys([key]);
		}
		text = "";
	}
	typeText(text);
	return inputs;
}

interface HcTerminal {
	address: string;
	argv: string[];
	cwd: string;
	exit_code: number | null;
	foreground: { name: string; cwd: string } | null;
	labels: Record<string, string>;
	state: string;
}

export class HerdrBackend implements TerminalBackend {
	readonly kind = "herdr";
	private readonly session: string;
	private next = 1;

	constructor(session: string) {
		this.session = session;
	}

	private hc(args: string[], signal?: AbortSignal): Promise<string> {
		return execText("hc", args, signal);
	}

	private async get(address: string, signal?: AbortSignal): Promise<WindowInfo> {
		const terminal = JSON.parse(await this.hc(["get", address, "--json"], signal)) as HcTerminal;
		const running = terminal.state === "live";
		const foreground = terminal.foreground?.name;
		const name = terminal.labels["pi.name"];
		return {
			window: Number(terminal.labels["pi.window"]),
			id: terminal.address,
			...(name ? { name } : {}),
			cwd: terminal.foreground?.cwd ?? terminal.cwd,
			opener: "agent",
			running,
			...(terminal.exit_code === null ? {} : { exitCode: terminal.exit_code }),
			...(running && foreground && foreground !== basename(terminal.argv[0] ?? "") ? { foreground } : {}),
		};
	}

	async open(options: { name?: string; cwd: string }, signal?: AbortSignal): Promise<WindowInfo> {
		const window = this.next++;
		const out = await this.hc(
			[
				"run",
				"--bg",
				"--json",
				// Without it hc types notes about the child into pi's own terminal, that is into its editor.
				"--no-notify",
				"--cwd",
				options.cwd,
				"--label",
				`pi.session=${this.session}`,
				"--label",
				`pi.window=${window}`,
				...(options.name ? ["--label", `pi.name=${options.name}`] : []),
			],
			signal,
		);
		return this.get((JSON.parse(out) as { address: string }).address, signal);
	}

	async list(signal?: AbortSignal): Promise<WindowInfo[]> {
		const out = await this.hc(["ls", "--json", "--all", "--label", `pi.session=${this.session}`], signal);
		const { terminals } = JSON.parse(out) as { terminals: Array<{ address: string }> };
		const windows = await Promise.all(terminals.map(({ address }) => this.get(address, signal)));
		return windows.sort((a, b) => a.window - b.window);
	}

	async resolve(target: string, signal?: AbortSignal): Promise<WindowInfo> {
		const windows = await this.list(signal);
		const window =
			windows.find((w) => w.id === target) ??
			(/^\d+$/.test(target) ? windows.find((w) => w.window === Number(target)) : undefined) ??
			windows.find((w) => w.name === target);
		if (!window) throw new Error(`can't find window: ${target}`);
		return window;
	}

	async send(window: WindowInfo, keys: string[], literal: boolean, signal?: AbortSignal): Promise<void> {
		for (const input of hcInputs(keys, literal)) {
			if (input.kind === "send") await this.hc(["send", window.id, input.text, "--json"], signal);
			else await this.hc(["keys", window.id, ...input.keys, "--json"], signal);
		}
	}

	async history(window: WindowInfo, signal?: AbortSignal): Promise<{ text: string; screen: boolean }> {
		// shortcut: hc does not tell when a full-screen program runs, so `screen` is never set; read the screen from
		// `hc get` if hc adds it.
		return { text: await this.read(window, 10_000, signal), screen: false };
	}

	async capture(window: WindowInfo, scrollback: number, _escapes: boolean, signal?: AbortSignal): Promise<string> {
		// shortcut: hc read has no colors, so `-e` is ignored.
		return this.read(window, scrollback, signal);
	}

	private async read(window: WindowInfo, lines: number, signal?: AbortSignal): Promise<string> {
		const out = await this.hc(["read", window.id, "--json", "--lines", String(lines)], signal);
		return trimBlankLines((JSON.parse(out) as { text: string }).text);
	}

	async kill(window: WindowInfo, signal?: AbortSignal): Promise<void> {
		if (window.running) await this.hc(["kill", window.id, "--json"], signal);
		// rm refuses a terminal that has not finished yet; kill escalates, so give it a moment.
		for (let attempt = 0; attempt < 20; attempt++) {
			if (
				await this.hc(["rm", window.id, "--json"], signal).then(
					() => true,
					() => false,
				)
			)
				return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	async dispose(): Promise<void> {
		const windows = await this.list().catch(() => []);
		await Promise.all(windows.map((window) => this.kill(window).catch(() => {})));
	}
}
