/**
 * One running language server: starts it, keeps the documents pi changed in sync, and returns fresh diagnostics for a
 * document after each change.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { JsonRpcConnection, JsonRpcTimeoutError } from "./json-rpc.ts";
import { type LspServerConfig, languageId } from "./servers.ts";

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface Diagnostic {
	/** 1-based. */
	line: number;
	/** 1-based. */
	column: number;
	severity: DiagnosticSeverity;
	message: string;
	source?: string;
	code?: string;
}

/** Diagnostics for the version just sent, or `timeout` when the server did not report them in time. */
export type DiagnosticsResult = { kind: "diagnostics"; diagnostics: Diagnostic[] } | { kind: "timeout" };

/** Why a server could not start. `not_installed`: its command was not found. */
export class LspStartError extends Error {
	readonly reason: "not_installed" | "failed";

	constructor(reason: "not_installed" | "failed", message: string) {
		super(message);
		this.name = "LspStartError";
		this.reason = reason;
	}
}

/** The LSP `Diagnostic` fields this client reads. */
interface WireDiagnostic {
	range?: { start?: { line?: number; character?: number } };
	severity?: number;
	message?: string;
	source?: string;
	code?: string | number;
}

interface PublishedDiagnostics {
	/** Increases with every publish for the document, so a waiter can tell new reports from old ones. */
	generation: number;
	version: number | undefined;
	diagnostics: Diagnostic[];
}

interface Waiter {
	accept(published: PublishedDiagnostics): boolean;
	/** Settles the wait: with the accepted report, or undefined when the server exited. */
	resolve(published: PublishedDiagnostics | undefined): void;
}

const SEVERITIES: readonly DiagnosticSeverity[] = ["error", "warning", "information", "hint"];

export interface LspClientOptions {
	/** Limit for spawning the server and its `initialize` answer. */
	initializeTimeoutMs: number;
}

export class LspClient {
	readonly config: LspServerConfig;
	private readonly child: ChildProcess;
	private readonly connection: JsonRpcConnection;
	private readonly versions = new Map<string, number>();
	private readonly published = new Map<string, PublishedDiagnostics>();
	private readonly waiters = new Map<string, Waiter[]>();
	private pullDiagnostics = false;
	private exited = false;

	/** Starts the server in `rootDir` and completes the LSP handshake. */
	static async start(config: LspServerConfig, rootDir: string, options: LspClientOptions): Promise<LspClient> {
		const [command, ...args] = config.command;
		const child = spawn(command, args, {
			cwd: rootDir,
			stdio: ["pipe", "pipe", "pipe"],
			// Servers installed in the project, such as typescript-language-server, come first.
			env: { ...process.env, PATH: `${join(rootDir, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` },
			// npm installs servers as .cmd shims on Windows, which only a shell can start.
			shell: process.platform === "win32",
			windowsHide: true,
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", (error: NodeJS.ErrnoException) =>
				reject(
					error.code === "ENOENT"
						? new LspStartError("not_installed", `${command} was not found`)
						: new LspStartError("failed", error.message),
				),
			);
		});
		const client = new LspClient(config, child, rootDir);
		try {
			await client.initialize(rootDir, options.initializeTimeoutMs);
		} catch (error) {
			client.kill();
			throw new LspStartError("failed", error instanceof Error ? error.message : String(error));
		}
		return client;
	}

	private constructor(config: LspServerConfig, child: ChildProcess, rootDir: string) {
		this.config = config;
		this.child = child;
		// Stderr is the server's log; it must be read so a chatty server does not block on a full pipe.
		child.stderr?.resume();
		const rootUri = pathToFileURL(rootDir).href;
		this.connection = new JsonRpcConnection(child.stdout!, child.stdin!, (method, params) =>
			answerServerRequest(method, params, rootUri),
		);
		this.connection.onNotification("textDocument/publishDiagnostics", (params) => this.onPublish(params));
		child.stdin?.on("error", () => {});
		child.once("exit", (code, signal) => {
			this.exited = true;
			this.connection.close(new Error(`${config.name} exited (${signal ?? `code ${code}`})`));
			for (const waiters of this.waiters.values()) for (const waiter of waiters.splice(0)) waiter.resolve(undefined);
		});
	}

	/** False once the server process has exited. */
	get running(): boolean {
		return !this.exited;
	}

	/**
	 * Sends `text` as the new content of `filePath`, which pi just wrote, and returns the diagnostics for it. Waits at
	 * most `timeoutMs`.
	 */
	async diagnostics(filePath: string, text: string, timeoutMs: number): Promise<DiagnosticsResult> {
		const uri = pathToFileURL(filePath).href;
		const previous = this.versions.get(uri);
		const version = (previous ?? 0) + 1;
		this.versions.set(uri, version);
		const generation = this.published.get(uri)?.generation ?? 0;
		// Register before sending: a fast server may publish before the next line runs.
		const published = this.pullDiagnostics ? undefined : this.waitForPublish(uri, version, generation, timeoutMs);
		if (previous === undefined) {
			this.connection.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: languageId(filePath), version, text },
			});
		} else {
			this.connection.notify("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text }],
			});
		}
		this.connection.notify("textDocument/didSave", { textDocument: { uri } });
		if (published) {
			const result = await published;
			return result ? { kind: "diagnostics", diagnostics: result.diagnostics } : { kind: "timeout" };
		}
		return this.pull(uri, timeoutMs);
	}

	/** Asks the server to exit, and kills it if it does not. */
	async stop(): Promise<void> {
		if (this.exited) return;
		try {
			await this.connection.request("shutdown", null, 1000);
			this.connection.notify("exit", null);
		} catch {
			// A server that does not answer is killed below.
		}
		this.kill();
	}

	private kill(): void {
		if (!this.exited) this.child.kill();
	}

	private async initialize(rootDir: string, timeoutMs: number): Promise<void> {
		const rootUri = pathToFileURL(rootDir).href;
		const result = (await this.connection.request(
			"initialize",
			{
				processId: process.pid,
				rootUri,
				workspaceFolders: [{ uri: rootUri, name: rootDir }],
				initializationOptions: this.config.initializationOptions,
				capabilities: {
					textDocument: {
						synchronization: { didSave: true, dynamicRegistration: false },
						publishDiagnostics: { versionSupport: true, relatedInformation: false },
						diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
					},
					workspace: { configuration: true, workspaceFolders: true },
					window: { workDoneProgress: true },
				},
			},
			timeoutMs,
		)) as { capabilities?: { diagnosticProvider?: unknown } } | null;
		this.pullDiagnostics = Boolean(result?.capabilities?.diagnosticProvider);
		this.connection.notify("initialized", {});
	}

	private async pull(uri: string, timeoutMs: number): Promise<DiagnosticsResult> {
		try {
			const report = (await this.connection.request(
				"textDocument/diagnostic",
				{ textDocument: { uri } },
				timeoutMs,
			)) as { kind?: string; items?: WireDiagnostic[] } | null;
			if (report?.kind === "unchanged") {
				return { kind: "diagnostics", diagnostics: this.published.get(uri)?.diagnostics ?? [] };
			}
			const diagnostics = (report?.items ?? []).map(toDiagnostic);
			this.published.set(uri, {
				generation: (this.published.get(uri)?.generation ?? 0) + 1,
				version: this.versions.get(uri),
				diagnostics,
			});
			return { kind: "diagnostics", diagnostics };
		} catch (error) {
			if (error instanceof JsonRpcTimeoutError) return { kind: "timeout" };
			throw error;
		}
	}

	/**
	 * Resolves with the first report for `version` or later; a report without a version counts when it is newer than
	 * `generation`. Resolves with undefined after `timeoutMs` or when the server exits, which then reads as a timeout.
	 */
	private waitForPublish(
		uri: string,
		version: number,
		generation: number,
		timeoutMs: number,
	): Promise<PublishedDiagnostics | undefined> {
		return new Promise((resolve) => {
			const waiters = this.waiters.get(uri) ?? [];
			this.waiters.set(uri, waiters);
			const waiter: Waiter = {
				accept: (published) =>
					published.version === undefined ? published.generation > generation : published.version >= version,
				resolve: (published) => {
					clearTimeout(timer);
					resolve(published);
				},
			};
			const timer = setTimeout(() => {
				const index = waiters.indexOf(waiter);
				if (index !== -1) waiters.splice(index, 1);
				resolve(undefined);
			}, timeoutMs);
			waiters.push(waiter);
		});
	}

	private onPublish(params: unknown): void {
		// Wire input: only the fields read below are trusted to exist when present.
		const { uri, version, diagnostics } = (params ?? {}) as {
			uri?: string;
			version?: number;
			diagnostics?: WireDiagnostic[];
		};
		if (typeof uri !== "string") return;
		const published: PublishedDiagnostics = {
			generation: (this.published.get(uri)?.generation ?? 0) + 1,
			version: typeof version === "number" ? version : undefined,
			diagnostics: (diagnostics ?? []).map(toDiagnostic),
		};
		this.published.set(uri, published);
		const waiters = this.waiters.get(uri);
		if (!waiters) return;
		for (const waiter of [...waiters]) {
			if (!waiter.accept(published)) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(published);
		}
	}
}

function toDiagnostic(wire: WireDiagnostic): Diagnostic {
	return {
		line: (wire.range?.start?.line ?? 0) + 1,
		column: (wire.range?.start?.character ?? 0) + 1,
		// LSP: a missing severity is up to the client; treat it as an error, as editors do.
		severity: SEVERITIES[(wire.severity ?? 1) - 1] ?? "error",
		message: wire.message ?? "",
		source: wire.source,
		code: wire.code === undefined ? undefined : String(wire.code),
	};
}

/** Answers the requests servers send during startup; pi has no configuration or UI to offer. */
function answerServerRequest(method: string, params: unknown, rootUri: string): unknown {
	switch (method) {
		case "workspace/configuration": {
			const items = (params as { items?: unknown[] } | null)?.items ?? [];
			return items.map(() => null);
		}
		case "workspace/workspaceFolders":
			return [{ uri: rootUri, name: rootUri }];
		default:
			// client/registerCapability, window/workDoneProgress/create, window/showMessageRequest, ...
			return null;
	}
}
