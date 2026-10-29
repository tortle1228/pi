import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonRpcConnection, JsonRpcTimeoutError } from "../src/extensions/lsp/json-rpc.ts";
import { LspClient, LspStartError } from "../src/extensions/lsp/lsp-client.ts";
import { LspManager } from "../src/extensions/lsp/lsp-manager.ts";
import { findServer, type LspServerConfig, resolveServers } from "../src/extensions/lsp/servers.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fixtures/fake-lsp-server.mjs", import.meta.url));

function fakeServer(mode: string): LspServerConfig {
	return { name: "fake", command: [process.execPath, FAKE_SERVER, mode], extensions: [".fake"] };
}

function frame(message: object): string {
	const body = JSON.stringify({ jsonrpc: "2.0", ...message });
	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Reads the frames a connection writes, so a test can act as the server. */
function sentMessages(output: PassThrough): Array<Record<string, unknown>> {
	const messages: Array<Record<string, unknown>> = [];
	let text = "";
	output.on("data", (chunk: Buffer) => {
		text += chunk.toString();
		for (let end = text.indexOf("\r\n\r\n"); end !== -1; end = text.indexOf("\r\n\r\n")) {
			const length = Number(/Content-Length: (\d+)/.exec(text.slice(0, end))?.[1]);
			if (text.length < end + 4 + length) return;
			messages.push(JSON.parse(text.slice(end + 4, end + 4 + length)));
			text = text.slice(end + 4 + length);
		}
	});
	return messages;
}

describe("JsonRpcConnection", () => {
	it("reads frames split across chunks and several frames in one chunk", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const sent = sentMessages(output);
		const connection = new JsonRpcConnection(input, output, () => null);
		const notifications: unknown[] = [];
		connection.onNotification("note", (params) => notifications.push(params));

		const first = connection.request("one", {}, 5_000);
		const second = connection.request("two", {}, 5_000);
		const both =
			frame({ id: 1, result: "a" }) + frame({ method: "note", params: { n: 1 } }) + frame({ id: 2, result: "b" });
		input.write(both.slice(0, 10));
		input.write(both.slice(10));

		expect(await Promise.all([first, second])).toEqual(["a", "b"]);
		expect(notifications).toEqual([{ n: 1 }]);
		expect(sent.map((message) => message.method)).toEqual(["one", "two"]);
	});

	it("answers server requests and rejects error responses", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const sent = sentMessages(output);
		const connection = new JsonRpcConnection(input, output, (method) => (method === "ask" ? [1] : undefined));

		const failing = connection.request("fail", {}, 5_000);
		input.write(frame({ id: "s1", method: "ask", params: {} }) + frame({ id: "s2", method: "other", params: {} }));
		input.write(frame({ id: 1, error: { code: -32601, message: "no such method" } }));

		await expect(failing).rejects.toThrow("no such method");
		expect(sent.slice(1)).toEqual([
			{ jsonrpc: "2.0", id: "s1", result: [1] },
			{ jsonrpc: "2.0", id: "s2", result: null },
		]);
	});

	it("rejects a request that is not answered in time, and pending requests on close", async () => {
		const connection = new JsonRpcConnection(new PassThrough(), new PassThrough(), () => null);
		await expect(connection.request("slow", {}, 10)).rejects.toBeInstanceOf(JsonRpcTimeoutError);

		const pending = connection.request("pending", {}, 5_000);
		connection.close(new Error("server exited"));
		await expect(pending).rejects.toThrow("server exited");
		await expect(connection.request("later", {}, 5_000)).rejects.toThrow("server exited");
	});
});

describe("LspClient", () => {
	let root: string;
	const clients: LspClient[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-lsp-"));
	});

	afterEach(async () => {
		await Promise.all(clients.splice(0).map((client) => client.stop()));
		rmSync(root, { recursive: true, force: true });
	});

	async function start(mode: string): Promise<LspClient> {
		const client = await LspClient.start(fakeServer(mode), root, { initializeTimeoutMs: 10_000 });
		clients.push(client);
		return client;
	}

	it.each(["push", "unversioned", "pull"])("returns the diagnostics of each new version (%s)", async (mode) => {
		const client = await start(mode);
		const file = join(root, "a.fake");

		expect(await client.diagnostics(file, "ok\n  ERROR here\n", 10_000)).toEqual({
			kind: "diagnostics",
			diagnostics: [{ line: 2, column: 3, severity: "error", message: "found ERROR", source: "fake", code: "1" }],
		});
		expect(await client.diagnostics(file, "ok\nfixed\n", 10_000)).toEqual({ kind: "diagnostics", diagnostics: [] });
	});

	it("ignores a report for an older version", async () => {
		const client = await start("stale");
		const file = join(root, "a.fake");
		await client.diagnostics(file, "ERROR\n", 10_000);

		expect(await client.diagnostics(file, "clean\n", 10_000)).toEqual({ kind: "diagnostics", diagnostics: [] });
	});

	it("reports a timeout when the server sends no diagnostics in time", async () => {
		const client = await start("silent");
		expect(await client.diagnostics(join(root, "a.fake"), "ERROR\n", 50)).toEqual({ kind: "timeout" });
	});

	it("reports a missing server command as not installed", async () => {
		const missing = { name: "missing", command: ["pi-no-such-language-server"], extensions: [".x"] };
		const error = await LspClient.start(missing, root, { initializeTimeoutMs: 10_000 }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(LspStartError);
		expect((error as LspStartError).reason).toBe("not_installed");
	});
});

describe("LspManager", () => {
	let root: string;
	let manager: LspManager;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-lsp-manager-"));
		manager = new LspManager({ diagnosticsTimeoutMs: 10_000 });
	});

	afterEach(async () => {
		await manager.stopAll();
		rmSync(root, { recursive: true, force: true });
	});

	it("reuses one server per name and directory", async () => {
		const server = fakeServer("push");
		const a = await manager.check(server, root, join(root, "a.fake"), "ERROR\n");
		const b = await manager.check(server, root, join(root, "b.fake"), "fine\n");
		expect(a).toMatchObject({ kind: "diagnostics", server: "fake", diagnostics: [{ line: 1 }] });
		expect(b).toEqual({ kind: "diagnostics", server: "fake", diagnostics: [] });
	});

	it("reports a server that cannot start once, then skips it", async () => {
		const missing = { name: "missing", command: ["pi-no-such-language-server"], extensions: [".x"] };
		expect(await manager.check(missing, root, join(root, "a.x"), "")).toEqual({
			kind: "unavailable",
			server: "missing",
			message: "pi-no-such-language-server is not installed, so .x files are not checked",
		});
		expect(await manager.check(missing, root, join(root, "a.x"), "")).toEqual({ kind: "skipped" });
	});

	it("restarts a server that exits, and gives up after three exits", async () => {
		const server = fakeServer("crash");
		const file = join(root, "a.fake");
		const outcomes: string[] = [];
		// Each round: didOpen starts a fresh server and succeeds, the next didChange makes it exit.
		for (let round = 0; round < 3; round++) {
			outcomes.push((await manager.check(server, root, file, "x\n")).kind);
			outcomes.push((await manager.check(server, root, file, "y\n")).kind);
		}
		outcomes.push((await manager.check(server, root, file, "z\n")).kind);
		expect(outcomes).toEqual([
			"diagnostics",
			"exited",
			"diagnostics",
			"exited",
			"diagnostics",
			"unavailable",
			"skipped",
		]);
	});
});

describe("resolveServers", () => {
	it("changes, disables, and adds servers by name", () => {
		const servers = resolveServers({
			typescript: { command: ["npx", "typescript-language-server", "--stdio"] },
			gopls: { disabled: true },
			zig: { command: ["zls"], extensions: [".ZIG"] },
			incomplete: { command: ["only-a-command"] },
		});
		expect(servers.map((server) => server.name)).toEqual(["typescript", "pyright", "rust-analyzer", "zig"]);
		expect(findServer(servers, "/repo/src/a.tsx")?.command).toEqual(["npx", "typescript-language-server", "--stdio"]);
		expect(findServer(servers, "/repo/main.zig")?.name).toBe("zig");
		expect(findServer(servers, "/repo/main.go")).toBeUndefined();
	});
});
