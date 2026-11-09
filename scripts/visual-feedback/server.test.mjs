import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer, updateReport, waitForResult } from "./server.mjs";

const image = {
	name: "capture.png",
	dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=",
};
const answer = {
	status: "submitted", imageSize: { width: 1, height: 1 }, note: "Move the menu left, keeping the colors.",
	annotations: [{ x: .1, y: .2, width: .3, height: .4, note: "Move this menu" }],
};

async function session(t, mode = "annotate") {
	const dir = await mkdtemp(join(tmpdir(), "visual-feedback-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const imagePath = join(dir, "capture.png");
	const requestPath = join(dir, "request.json");
	await writeFile(imagePath, Buffer.from(image.dataUrl.split(",")[1], "base64"));
	await writeFile(requestPath, JSON.stringify(mode === "choose" ? {
		mode, question: "어떤 시안을 선택할까요?", options: [
			{ id: "first", label: "첫 번째 시안", image: "capture.png" },
			{ id: "second", label: "두 번째 시안", image: "capture.png" },
		],
	} : mode === "report" ? { mode, question: "작업 결과", images: [
		{ id: "desktop", label: "데스크톱", image: "capture.png" },
		{ id: "mobile", label: "모바일", image: "capture.png" },
	] } : { mode, question: "어디를 수정할까요?", current: "capture.png" }));
	const value = await startServer(requestPath);
	t.after(() => { value.server.close(); value.server.closeAllConnections(); });
	const url = new URL(value.url);
	const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
	return { ...value, origin: url.origin, headers, requestPath, imagePath };
}

test("serves a local page and waits until submitted; result remains available", async (t) => {
	const s = await session(t);
	const page = await fetch(s.origin);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /현재 화면/);
	assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
	const script = await fetch(`${s.origin}/client.js`);
	assert.equal(script.status, 200);
	let resolved = false;
	const waiting = waitForResult(s.url, 5).then((result) => { resolved = true; return result; });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(resolved, false);
	const sent = await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify(answer) });
	assert.equal(sent.status, 200);
	const result = await waiting;
	assert.deepEqual(result.annotations, answer.annotations);
	assert.deepEqual(result.current, { ...image, path: s.imagePath });
	assert.equal(result.mode, "annotate");
	assert.equal("reference" in result, false);
	assert.deepEqual(result.imageSize, answer.imageSize);
	assert.equal(result.question, "어디를 수정할까요?");
	assert.equal(result.coordinateSpace, "normalized-current-image");
	assert.equal(result.note, answer.note);
	assert.deepEqual(await waitForResult(s.url, 1), result);
	assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify(answer) })).status, 409);
});

test("rejects unauthenticated, cross-origin, malformed and out-of-bounds input", async (t) => {
	const s = await session(t);
	assert.equal((await fetch(`${s.origin}/result`)).status, 403);
	assert.equal((await fetch(`${s.origin}/session`)).status, 403);
	assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: { ...s.headers, Origin: "https://attacker.example" }, body: "{}" })).status, 403);
	assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: "{" })).status, 400);
	for (const invalid of [
		{ ...answer, current: image },
		{ ...answer, imageSize: { width: -1, height: 1 } },
		{ ...answer, imageSize: null },
		{ ...answer, annotations: [{ x: .9, y: 0, width: .5, height: .5, note: "Outside" }] },
		{ ...answer, annotations: [{ x: 0, y: 0, width: 0, height: .5, note: "Empty" }] },
	]) {
		const response = await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify(invalid) });
		assert.equal(response.status, 400);
	}
	assert.equal((await fetch(`${s.origin}/../../etc/passwd`, { headers: s.headers })).status, 404);
});

test("user page has no image-upload controls", async (t) => {
	const s = await session(t);
	const page = await (await fetch(s.origin)).text();
	assert.doesNotMatch(page, /type="file"/);
});

test("agent supplies images and question; page reloads cannot replace the source", async (t) => {
	const s = await session(t);
	const prepared = await (await fetch(`${s.origin}/session`, { headers: s.headers })).json();
	assert.equal(prepared.question, "어디를 수정할까요?");
	assert.equal(prepared.current.dataUrl, image.dataUrl);
	assert.equal(prepared.current.path, s.imagePath);
	assert.equal("reference" in prepared, false);
	assert.equal(prepared.completed, false);
	await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify(answer) });
	const reloaded = await (await fetch(`${s.origin}/session`, { headers: s.headers })).json();
	assert.equal(reloaded.completed, true);
	assert.deepEqual(reloaded.current, prepared.current);
});

test("rejects missing image paths and unsupported image content before serving", async (t) => {
	const s = await session(t);
	await writeFile(s.requestPath, JSON.stringify({ mode: "annotate", question: "Where?" }));
	await assert.rejects(startServer(s.requestPath), /current image path/);
	await writeFile(s.requestPath, JSON.stringify({ mode: "annotate", question: "Where?", current: "missing.png" }));
	await assert.rejects(startServer(s.requestPath), { code: "ENOENT" });
	await writeFile(s.imagePath, "<svg></svg>");
	await writeFile(s.requestPath, JSON.stringify({ mode: "annotate", question: "Where?", current: "capture.png" }));
	await assert.rejects(startServer(s.requestPath), /Expected PNG/);
});

test("choose accepts only a prepared option and returns its stable id", async (t) => {
	const s = await session(t, "choose");
	const prepared = await (await fetch(`${s.origin}/session`, { headers: s.headers })).json();
	assert.equal(prepared.mode, "choose");
	assert.equal(prepared.options.length, 2);
	for (const invalid of [answer, { status: "submitted", optionId: "unknown" }, { status: "submitted" }]) {
		assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify(invalid) })).status, 400);
	}
	const waiting = waitForResult(s.url, 2);
	assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers,
		body: JSON.stringify({ ...answer, optionId: "second" }) })).status, 200);
	const result = await waiting;
	assert.equal(result.optionId, "second");
	assert.equal(result.mode, "choose");
	assert.equal(result.options[1].image.path, s.imagePath);
	assert.deepEqual(result.annotations, answer.annotations);
	assert.equal(result.current.path, s.imagePath);
	assert.equal(result.coordinateSpace, "normalized-current-image");
});

test("unchanged designs can finish through choose or standalone annotate", async (t) => {
	for (const mode of ["choose", "annotate"]) {
		const s = await session(t, mode);
		const unchanged = { ...answer, note: "", annotations: [], ...(mode === "choose" ? { optionId: "first" } : {}) };
		const response = await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify(unchanged) });
		assert.equal(response.status, 200);
		const result = await waitForResult(s.url, 1);
		assert.deepEqual(result.annotations, []);
		assert.equal(result.note, "");
	}
});

test("report updates while edit feedback stays bound to the captured image", async (t) => {
	const s = await session(t, "report");
	const prepared = await (await fetch(`${s.origin}/session`, { headers: s.headers })).json();
	assert.equal(prepared.revision, 1);
	assert.equal((await fetch(`${s.origin}/session?revision=1`, { headers: s.headers })).status, 204);
	assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify({ status: "cancelled" }) })).status, 400);
	const captured = await (await fetch(`${s.origin}/edit`, { method: "POST", headers: s.headers, body: JSON.stringify({ imageId: "mobile", revision: 1 }) })).json();
	assert.equal(captured.revision, 1);
	assert.equal(captured.imageId, "mobile");
	const waiting = waitForResult(s.url, 2);
	const update = { mode: "report", question: "Updated screen", images: [{ id: "desktop", label: "데스크톱", image: { ...image, path: s.imagePath } }] };
	assert.equal((await fetch(`${s.origin}/report`, { method: "POST", headers: s.headers, body: JSON.stringify(update) })).status, 200);
	const changed = await (await fetch(`${s.origin}/session?revision=1`, { headers: s.headers })).json();
	assert.equal(changed.revision, 2);
	assert.equal(changed.question, "Updated screen");
	for (const invalid of [
		{ ...update, question: "" },
		{ ...update, images: [{ id: "desktop", label: "Bad", image: { ...image, path: s.imagePath, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" } }] },
		{ ...update, images: [{ id: "desktop", label: "Bad", image: { ...image, path: s.imagePath, dataUrl: "data:image/png;base64,YWJj" } }] },
		{ ...update, images: [] },
		{ ...update, images: [update.images[0], update.images[0]] },
	]) {
		assert.equal((await fetch(`${s.origin}/report`, { method: "POST", headers: s.headers, body: JSON.stringify(invalid) })).status, 400);
	}
	assert.equal((await (await fetch(`${s.origin}/session`, { headers: s.headers })).json()).revision, 2);
	assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify({ ...answer, editId: captured.editId }) })).status, 200);
	const feedback = await waiting;
	assert.equal(feedback.reportRevision, 1);
	assert.equal(feedback.question, prepared.question);
	assert.equal(feedback.mode, "annotate");
	assert.equal(feedback.imageId, "mobile");
	await assert.rejects(waitForResult(s.url, .05), { name: "TimeoutError" });
});

test("report CLI updates are validated before replacing the current screen", async (t) => {
	const s = await session(t, "report");
	await writeFile(s.requestPath, JSON.stringify({ mode: "report", question: "Next", images: [{ id: "desktop", label: "화면", image: "capture.png" }] }));
	assert.equal((await updateReport(s.url, s.requestPath)).revision, 2);
	await writeFile(s.requestPath, JSON.stringify({ mode: "report", question: "Broken", images: [{ id: "desktop", label: "화면", image: "missing.png" }] }));
	await assert.rejects(updateReport(s.url, s.requestPath), { code: "ENOENT" });
	const screen = await (await fetch(`${s.origin}/session`, { headers: s.headers })).json();
	assert.equal(screen.question, "Next");
	assert.equal(screen.revision, 2);
	assert.equal((await fetch(`${s.origin}/edit`, { method: "POST", headers: s.headers, body: JSON.stringify({ imageId: "desktop", revision: 1 }) })).status, 409);
	const edit = await (await fetch(`${s.origin}/edit`, { method: "POST", headers: s.headers, body: JSON.stringify({ imageId: "desktop", revision: 2 }) })).json();
	assert.equal((await fetch(`${s.origin}/edit`, { method: "POST", headers: s.headers, body: JSON.stringify({ editId: edit.editId, cancel: true }) })).status, 200);
	assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify({ ...answer, editId: edit.editId }) })).status, 400);
});

test("uncollected report feedback is not overwritten by another submission", async (t) => {
	const s = await session(t, "report");
	const first = await (await fetch(`${s.origin}/edit`, { method: "POST", headers: s.headers, body: JSON.stringify({ imageId: "desktop", revision: 1 }) })).json();
	assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify({ ...answer, editId: first.editId }) })).status, 200);
	const second = await (await fetch(`${s.origin}/edit`, { method: "POST", headers: s.headers, body: JSON.stringify({ imageId: "mobile", revision: 1 }) })).json();
	const next = { ...answer, note: "Second request", editId: second.editId };
	assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify(next) })).status, 409);
	assert.equal((await waitForResult(s.url, 1)).imageId, "desktop");
	assert.equal((await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify(next) })).status, 200);
	const collected = await waitForResult(s.url, 1);
	assert.equal(collected.imageId, "mobile");
	assert.equal(collected.note, "Second request");
});

test("reports cannot replace a feedback session", async (t) => {
	const s = await session(t);
	assert.equal((await fetch(`${s.origin}/report`, { method: "POST", headers: s.headers, body: "{}" })).status, 409);
});

test("annotation requests reject reference comparisons rather than silently ignoring them", async (t) => {
	const s = await session(t);
	await writeFile(s.requestPath, JSON.stringify({ mode: "annotate", question: "Where?", current: "capture.png", reference: "capture.png" }));
	await assert.rejects(async () => {
		const unexpected = await startServer(s.requestPath);
		t.after(() => { unexpected.server.close(); unexpected.server.closeAllConnections(); });
	}, /fields/);
});

test("bounds body size", async (t) => {
	const s = await session(t);
	const response = await fetch(`${s.origin}/answer`, {
		method: "POST", headers: s.headers, body: " ".repeat(256 * 1024 + 1),
	});
	assert.equal(response.status, 413);
});

test("wait times out without making a decision, and can be retried", async (t) => {
	const s = await session(t);
	await assert.rejects(waitForResult(s.url, .05), { name: "TimeoutError" });
	await assert.rejects(waitForResult(s.url, -1), /Timeout/);
	await assert.rejects(waitForResult("https://example.com/#abc", 1), /local session URL/);
	const response = await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify({ status: "cancelled" }) });
	assert.equal(response.status, 200);
	assert.equal((await waitForResult(s.url, 1)).status, "cancelled");
});

test("CLI wait outputs machine-readable JSON after browser submission", async (t) => {
	const s = await session(t);
	const child = spawn(process.execPath, [new URL("server.mjs", import.meta.url).pathname, "wait", s.url, "5"]);
	t.after(() => child.kill());
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const exited = once(child, "exit");
	await fetch(`${s.origin}/answer`, { method: "POST", headers: s.headers, body: JSON.stringify(answer) });
	const [code] = await exited;
	assert.equal(code, 0, stderr);
	assert.equal(JSON.parse(stdout).status, "submitted");
});
