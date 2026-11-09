import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BODY = 256 * 1024;
const assets = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/client.js", ["client.js", "text/javascript; charset=utf-8"]],
]);

function imageType(bytes) {
	if (bytes.length > 5 * 1024 * 1024) throw new Error("Image exceeds 5 MiB");
	let type;
	if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) type = "png";
	else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = "jpeg";
	else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") type = "webp";
	else throw new Error("Expected PNG, JPEG, or WebP");
	return type;
}

async function loadImage(path) {
	const bytes = await readFile(path);
	return { path, name: basename(path), dataUrl: `data:image/${imageType(bytes)};base64,${bytes.toString("base64")}` };
}

function validReport(update) {
	if (!update || update.mode !== "report" || Object.keys(update).some((key) => !["mode", "question", "images"].includes(key)) ||
		typeof update.question !== "string" || !update.question.trim() || update.question.length > 8000 ||
		!Array.isArray(update.images) || update.images.length < 1 || update.images.length > 20) return false;
	const ids = new Set();
	return update.images.every((entry) => {
		if (!entry || typeof entry.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id) || ids.has(entry.id) ||
			typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 120) return false;
		ids.add(entry.id);
		const image = entry.image;
		if (!image || typeof image.name !== "string" || image.name.length > 255 || typeof image.path !== "string" || image.path.length > 4096 || typeof image.dataUrl !== "string") return false;
		const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
		if (!match) return false;
		const bytes = Buffer.from(match[2], "base64");
		try { return bytes.toString("base64") === match[2] && imageType(bytes) === match[1]; }
		catch { return false; }
	});
}

function validAnswer(answer, session) {
	if (!answer || !["submitted", "cancelled"].includes(answer.status)) return false;
	if (answer.status === "cancelled") return session.mode !== "report" && Object.keys(answer).length === 1;
	const fields = ["status", "imageSize", "note", "annotations"];
	if (session.mode === "report") fields.push("editId");
	if (session.mode === "choose") {
		fields.push("optionId");
		if (!session.options.some((option) => option.id === answer.optionId)) return false;
	}
	if (Object.keys(answer).some((key) => !fields.includes(key))) return false;
	if (!answer.imageSize || ![answer.imageSize.width, answer.imageSize.height].every((n) => Number.isInteger(n) && n > 0 && n <= 20000)) return false;
	if (typeof answer.note !== "string" || answer.note.length > 8000) return false;
	if (!Array.isArray(answer.annotations) || answer.annotations.length > 100) return false;
	return answer.annotations.every((item) => {
		if (!item || typeof item.note !== "string" || !item.note.trim() || item.note.length > 2000) return false;
		const { x, y, width, height } = item;
		return [x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 &&
			x + width <= 1.000001 && y + height <= 1.000001;
	});
}

async function prepareSession(requestPath) {
	const path = resolve(requestPath);
	const request = JSON.parse(await readFile(path, "utf8"));
	if (!request || typeof request.question !== "string" || !request.question.trim() || request.question.length > 8000 ||
		!["choose", "annotate", "report"].includes(request.mode)) {
		throw new Error("Request needs a question and mode: choose, annotate, or report");
	}
	const listKey = request.mode === "choose" ? "options" : "images";
	const fields = request.mode === "annotate" ? ["mode", "question", "current"] : ["mode", "question", listKey];
	if (Object.keys(request).some((key) => !fields.includes(key))) throw new Error("Unexpected request fields");
	const session = { mode: request.mode, question: request.question };
	if (request.mode !== "annotate") {
		const entries = request[listKey];
		const minimum = request.mode === "choose" ? 2 : 1;
		const maximum = request.mode === "choose" ? 4 : 20;
		if (!Array.isArray(entries) || entries.length < minimum || entries.length > maximum ||
			!entries.every((entry) => entry && typeof entry.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(entry.id) &&
				typeof entry.label === "string" && entry.label.trim() && entry.label.length <= 120 &&
				typeof entry.image === "string" && entry.image) ||
			new Set(entries.map((entry) => entry.id)).size !== entries.length) {
			throw new Error(`${request.mode} needs ${minimum}–${maximum} images with unique ids, labels, and image paths`);
		}
		session[listKey] = await Promise.all(entries.map(async (entry) => ({
			id: entry.id, label: entry.label, image: await loadImage(resolve(dirname(path), entry.image)),
		})));
	} else {
		if (typeof request.current !== "string" || !request.current) throw new Error("Request needs a current image path");
		session.current = await loadImage(resolve(dirname(path), request.current));
	}
	if (request.mode === "report" && Buffer.byteLength(JSON.stringify(session)) > 16 * 1024 * 1024) throw new Error("Report exceeds 16 MiB");
	return session;
}

export async function startServer(requestPath) {
	let session = await prepareSession(requestPath);
	let revision = 1;
	let edit = null;
	const token = randomBytes(24).toString("hex");
	const files = new Map(await Promise.all([...assets].map(async ([route, [file, type]]) =>
		[route, { body: await readFile(new URL(file, import.meta.url)), type }])));
	let result;
	let origin;
	const waiters = new Set();
	const server = createServer(async (request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
		const send = (status, value) => {
			response.writeHead(status, { "Content-Type": "application/json" });
			response.end(value === undefined ? undefined : JSON.stringify(value));
		};
		try {
			if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
				send(403, { error: "Local requests only" });
				return;
			}
			const asset = files.get(request.url);
			if (request.method === "GET" && asset) {
				response.writeHead(200, { "Content-Type": asset.type });
				response.end(asset.body);
				return;
			}
			const auth = Buffer.from(request.headers.authorization ?? "");
			const expected = Buffer.from(`Bearer ${token}`);
			if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
				send(403, { error: "Invalid session token" });
				return;
			}
			const route = new URL(request.url, origin);
			if (request.method === "GET" && route.pathname === "/session") {
				if (session.mode === "report" && route.searchParams.get("revision") === String(revision)) return send(204);
				return send(200, { ...session, revision, completed: session.mode !== "report" && Boolean(result) });
			}
			if (request.method === "GET" && request.url === "/result") {
				if (result) {
					send(200, result);
					if (session.mode === "report") result = undefined;
					return;
				}
				const finish = (status, value) => {
					clearTimeout(timer);
					waiters.delete(finish);
					send(status, value);
				};
				const timer = setTimeout(() => finish(204), 25000);
				waiters.add(finish);
				response.on("close", () => { clearTimeout(timer); waiters.delete(finish); });
				return;
			}
			if (request.method !== "POST" || !["/answer", "/report", "/edit"].includes(request.url)) return send(404, { error: "Not found" });
			if (request.url !== "/answer" && session.mode !== "report") return send(409, { error: "Not a report session" });
			if (request.url === "/answer" && result) return send(409, { error: "Previous feedback has not been collected or this session is complete" });
			if (request.headers["content-type"] !== "application/json") return send(415, { error: "Expected JSON" });
			const chunks = [];
			let size = 0;
			for await (const chunk of request) {
				size += chunk.length;
				if (size > (request.url === "/report" ? 16 * 1024 * 1024 : MAX_BODY)) return send(413, { error: "Request exceeds size limit" });
				chunks.push(chunk);
			}
			let answer;
			try { answer = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
			catch { return send(400, { error: "Invalid JSON" }); }
			if (request.url === "/report") {
				if (!validReport(answer)) return send(400, { error: "Invalid report image or description" });
				session = { mode: "report", question: answer.question, images: answer.images.map((entry) => ({
					id: entry.id, label: entry.label, image: { name: entry.image.name, path: entry.image.path, dataUrl: entry.image.dataUrl },
				})) };
				revision++;
				return send(200, { ok: true, revision });
			}
			if (request.url === "/edit") {
				if (!answer || typeof answer !== "object" || Array.isArray(answer)) return send(400, { error: "Invalid edit request" });
				const selected = session.images.find((entry) => entry.id === answer.imageId);
				if (Object.keys(answer).length === 2 && selected && answer.revision === revision) {
					edit = { question: session.question, current: selected.image, imageId: selected.id, revision, editId: randomBytes(16).toString("hex") };
					return send(200, edit);
				}
				if (Object.keys(answer).length === 2 && answer.cancel === true && edit && answer.editId === edit.editId) {
					edit = null;
					return send(200, { ok: true });
				}
				return send(409, { error: "Edit is no longer active" });
			}
			if (!validAnswer(answer, session) || (session.mode === "report" && (!edit || answer.editId !== edit.editId))) return send(400, { error: "Invalid image size, regions, or feedback" });
			// A different tab may have submitted while this request body was arriving.
			if (result) return send(409, { error: "This session already has a final answer" });
			const source = session.mode === "report" ? { mode: "annotate", question: edit.question, current: edit.current, imageId: edit.imageId, reportRevision: edit.revision } : session;
			result = { ...answer, ...source, submittedAt: new Date().toISOString() };
			if (answer.status === "submitted") {
				result.coordinateSpace = "normalized-current-image";
				if (session.mode === "choose") result.current = session.options.find((option) => option.id === answer.optionId).image;
			}
			if (session.mode === "report") {
				edit = null;
				const first = waiters.values().next().value;
				if (first) { first(200, result); result = undefined; }
			} else {
				for (const finish of waiters) finish(200, result);
			}
			send(200, { ok: true });
		} catch (error) {
			console.error(error);
			if (!response.headersSent) send(500, { error: "Request failed" });
			else response.destroy();
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	origin = `http://127.0.0.1:${server.address().port}`;
	return { server, url: `${origin}/#${token}`, mode: session.mode };
}

function sessionUrl(url) {
	const session = new URL(url);
	if (session.protocol !== "http:" || session.hostname !== "127.0.0.1" || !/^[a-f0-9]{48}$/.test(session.hash.slice(1))) {
		throw new Error("Use the complete local session URL printed by serve");
	}
	return session;
}

export async function updateReport(url, requestPath) {
	const session = sessionUrl(url);
	const update = await prepareSession(requestPath);
	if (update.mode !== "report") throw new Error("Update requires a report request");
	const response = await fetch(new URL("/report", session), {
		method: "POST", headers: { Authorization: `Bearer ${session.hash.slice(1)}`, "Content-Type": "application/json" },
		body: JSON.stringify(update), signal: AbortSignal.timeout(30000), redirect: "error",
	});
	if (!response.ok) throw new Error(`Report update failed: HTTP ${response.status}`);
	return response.json();
}

export async function waitForResult(url, timeoutSeconds = 600) {
	const session = sessionUrl(url);
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86400) {
		throw new Error("Timeout must be between 0 and 86400 seconds (exclusive of 0)");
	}
	const signal = AbortSignal.timeout(Math.ceil(timeoutSeconds * 1000));
	while (true) {
		const response = await fetch(new URL("/result", session), {
			headers: { Authorization: `Bearer ${session.hash.slice(1)}` }, signal, redirect: "error",
		});
		if (response.status === 204) continue;
		if (!response.ok) throw new Error(`Result request failed: HTTP ${response.status}`);
		return response.json();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		if (process.argv[2] === "serve" && process.argv[3] && process.argv.length === 4) {
			const { server, url, mode } = await startServer(process.argv[3]);
			console.log(JSON.stringify({ url, mode, ...(mode === "report" ? { update: `node scripts/visual-feedback/server.mjs update '${url}' <request.json>` } : { wait: `node scripts/visual-feedback/server.mjs wait '${url}'` }) }));
			const stop = () => { server.close(); server.closeAllConnections(); };
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		} else if (process.argv[2] === "update" && process.argv[3] && process.argv[4] && process.argv.length === 5) {
			console.log(JSON.stringify(await updateReport(process.argv[3], process.argv[4])));
		} else if (process.argv[2] === "wait" && process.argv[3] && process.argv.length <= 5) {
			console.log(JSON.stringify(await waitForResult(process.argv[3], Number(process.argv[4] ?? 600))));
		} else {
			throw new Error("Usage: node scripts/visual-feedback/server.mjs serve <request.json> | update <session-url> <request.json> | wait <session-url> [timeout-seconds]");
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
