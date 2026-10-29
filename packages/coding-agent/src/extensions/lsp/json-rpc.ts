/**
 * JSON-RPC 2.0 over a language server's stdio, framed with `Content-Length` headers as LSP specifies.
 */

import type { Readable, Writable } from "node:stream";

/** A request the server did not answer in time. The server may still be working on it. */
export class JsonRpcTimeoutError extends Error {
	constructor(method: string, timeoutMs: number) {
		super(`${method} did not answer within ${timeoutMs}ms`);
		this.name = "JsonRpcTimeoutError";
	}
}

/** Answers a request the server sends to the client, such as `workspace/configuration`. */
export type ServerRequestHandler = (method: string, params: unknown) => unknown;

/** The fields of a JSON-RPC message this connection reads; anything else is ignored. */
interface JsonRpcMessage {
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

interface PendingRequest {
	resolve(result: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

const HEADER_END = "\r\n\r\n";

/** One connection to a language server. */
export class JsonRpcConnection {
	private readonly output: Writable;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
	private readonly onServerRequest: ServerRequestHandler;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private closedError: Error | undefined;

	constructor(input: Readable, output: Writable, onServerRequest: ServerRequestHandler) {
		this.output = output;
		this.onServerRequest = onServerRequest;
		input.on("data", (chunk: Buffer) => this.receive(chunk));
	}

	/** Sends a request; rejects when the server answers with an error, does not answer in time, or the connection closes. */
	request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		if (this.closedError) return Promise.reject(this.closedError);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new JsonRpcTimeoutError(method, timeoutMs));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.closedError) this.send({ jsonrpc: "2.0", method, params });
	}

	onNotification(method: string, handler: (params: unknown) => void): void {
		this.notificationHandlers.set(method, handler);
	}

	/** Rejects every pending request; for a server that exited. */
	close(error: Error): void {
		this.closedError ??= error;
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			request.reject(this.closedError);
			this.pending.delete(id);
		}
	}

	private send(message: object): void {
		const body = Buffer.from(JSON.stringify(message), "utf-8");
		this.output.write(`Content-Length: ${body.length}${HEADER_END}`);
		this.output.write(body);
	}

	private receive(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf(HEADER_END);
			if (headerEnd === -1) return;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
			const bodyStart = headerEnd + HEADER_END.length;
			if (!Number.isFinite(length)) {
				// Wire input: a frame without a length cannot be skipped reliably, so drop what was read.
				this.buffer = Buffer.alloc(0);
				return;
			}
			if (this.buffer.length < bodyStart + length) return;
			const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
			this.buffer = this.buffer.subarray(bodyStart + length);
			let message: JsonRpcMessage;
			try {
				message = JSON.parse(body) as JsonRpcMessage;
			} catch {
				continue;
			}
			this.dispatch(message);
		}
	}

	private dispatch(message: JsonRpcMessage): void {
		if (message.method === undefined) {
			const request = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
			if (!request || typeof message.id !== "number") return;
			this.pending.delete(message.id);
			clearTimeout(request.timer);
			if (message.error) request.reject(new Error(message.error.message));
			else request.resolve(message.result);
			return;
		}
		if (message.id === undefined || message.id === null) {
			this.notificationHandlers.get(message.method)?.(message.params);
			return;
		}
		let result: unknown = null;
		try {
			result = this.onServerRequest(message.method, message.params);
		} catch {
			// A failing handler still answers, so the server is not left waiting.
		}
		this.send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
	}
}
