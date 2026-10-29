/**
 * The language servers of one session: starts each on first use, reports a server that cannot start only once, and
 * stops them all when the session ends.
 */

import { type Diagnostic, LspClient, LspStartError } from "./lsp-client.ts";
import type { LspServerConfig } from "./servers.ts";

/**
 * What one check found. `unavailable` is returned once per server, the first time it cannot run; later checks for
 * that server return `skipped`.
 */
export type CheckOutcome =
	| { kind: "diagnostics"; server: string; diagnostics: Diagnostic[] }
	| { kind: "timeout"; server: string; waitedMs: number }
	/** The server exited while checking; the next check starts it again. */
	| { kind: "exited"; server: string }
	| { kind: "unavailable"; server: string; message: string }
	| { kind: "skipped" };

export interface LspManagerOptions {
	/** Limit for starting a server and its `initialize` answer. Default: 15 seconds. */
	initializeTimeoutMs?: number;
	/** Limit for a server's first diagnostics, while it loads the project. Default: 10 seconds. */
	firstDiagnosticsTimeoutMs?: number;
	/** Limit for later diagnostics. Default: 3 seconds. */
	diagnosticsTimeoutMs?: number;
}

/** A server that exits this often during one session is not started again. */
const MAX_EXITS = 3;

interface ClientEntry {
	client: Promise<LspClient>;
	checks: number;
}

export class LspManager {
	private readonly initializeTimeoutMs: number;
	private readonly firstDiagnosticsTimeoutMs: number;
	private readonly diagnosticsTimeoutMs: number;
	private readonly clients = new Map<string, ClientEntry>();
	private readonly exits = new Map<string, number>();
	/** Servers that cannot run in this session; already reported. */
	private readonly unavailable = new Set<string>();

	constructor(options: LspManagerOptions = {}) {
		this.initializeTimeoutMs = options.initializeTimeoutMs ?? 15_000;
		this.firstDiagnosticsTimeoutMs = options.firstDiagnosticsTimeoutMs ?? 10_000;
		this.diagnosticsTimeoutMs = options.diagnosticsTimeoutMs ?? 3_000;
	}

	/** Checks `filePath`, whose new content is `text`, with `server` running in `rootDir`. */
	async check(server: LspServerConfig, rootDir: string, filePath: string, text: string): Promise<CheckOutcome> {
		if (this.unavailable.has(server.name)) return { kind: "skipped" };
		const key = `${server.name}\0${rootDir}`;
		let entry = this.clients.get(key);
		if (!entry) {
			entry = {
				client: LspClient.start(server, rootDir, { initializeTimeoutMs: this.initializeTimeoutMs }),
				checks: 0,
			};
			this.clients.set(key, entry);
		}
		let client: LspClient;
		try {
			client = await entry.client;
		} catch (error) {
			this.clients.delete(key);
			return this.markUnavailable(server, startFailureMessage(server, error));
		}
		const waitedMs = entry.checks++ === 0 ? this.firstDiagnosticsTimeoutMs : this.diagnosticsTimeoutMs;
		try {
			const result = await client.diagnostics(filePath, text, waitedMs);
			if (result.kind === "diagnostics")
				return { kind: "diagnostics", server: server.name, diagnostics: result.diagnostics };
			if (client.running) return { kind: "timeout", server: server.name, waitedMs };
		} catch {
			// The connection closed: the server exited while checking.
		}
		this.clients.delete(key);
		const exits = (this.exits.get(server.name) ?? 0) + 1;
		this.exits.set(server.name, exits);
		if (exits >= MAX_EXITS) {
			return this.markUnavailable(
				server,
				`${server.name} exited ${exits} times and is not started again in this session`,
			);
		}
		return { kind: "exited", server: server.name };
	}

	/** Stops every server; for session end. */
	async stopAll(): Promise<void> {
		const entries = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(
			entries.map(async (entry) => {
				try {
					await (await entry.client).stop();
				} catch {
					// A server that never started has nothing to stop.
				}
			}),
		);
	}

	private markUnavailable(server: LspServerConfig, message: string): CheckOutcome {
		this.unavailable.add(server.name);
		return { kind: "unavailable", server: server.name, message };
	}
}

function startFailureMessage(server: LspServerConfig, error: unknown): string {
	if (error instanceof LspStartError && error.reason === "not_installed") {
		return `${server.command[0]} is not installed, so ${server.extensions.join(", ")} files are not checked`;
	}
	return `${server.name} could not start: ${error instanceof Error ? error.message : String(error)}`;
}
