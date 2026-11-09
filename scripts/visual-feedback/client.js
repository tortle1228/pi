const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
const canvas = $("overlay");
const context = canvas.getContext("2d");
let session;
let step;
let optionId = null;
let current = null;
let selection = null;
let drag = null;
const annotations = [];
let loading = true;
let busy = false;
let finished = false;
let editId = null;
let editQuestion = "";
let reportRevision = 0;
let reportImageId = null;
let reportLoad = 0;
let closed = false;
window.addEventListener("pagehide", () => { closed = true; });

function status(message) { $("status").textContent = message; }
function updateSubmit() {
	$("submit").disabled = loading || busy || finished || (step === "choose" && !optionId);
	$("submit").textContent = step === "choose" ? "다음" :
		annotations.length || $("note").value.trim() || selection || $("region-note").value.trim() ? "수정 요청 제출" : "그대로 진행";
}
function draw() {
	context.clearRect(0, 0, canvas.width, canvas.height);
	for (const [index, item] of [...annotations, ...(selection ? [selection] : [])].entries()) {
		const { x, y, width, height } = item;
		context.fillStyle = "rgba(36,75,197,.13)";
		context.strokeStyle = "#244bc5";
		context.lineWidth = 2;
		context.fillRect(x * canvas.width, y * canvas.height, width * canvas.width, height * canvas.height);
		context.strokeRect(x * canvas.width, y * canvas.height, width * canvas.width, height * canvas.height);
		context.fillStyle = "#244bc5";
		context.font = "bold 18px system-ui";
		context.fillText(String(index + 1), x * canvas.width + 5, y * canvas.height + 22);
	}
	$("add").disabled = !selection;
	$("clear-selection").disabled = !selection;
	updateSubmit();
}
function fitImage() {
	if (!current) return;
	const preview = $("preview");
	const style = getComputedStyle(preview);
	const width = preview.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
	const height = preview.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
	const scale = Math.min(width / current.width, height / current.height);
	$("current-stage").style.width = `${Math.max(1, current.width * scale)}px`;
	$("current-stage").style.height = `${Math.max(1, current.height * scale)}px`;
}
new ResizeObserver(fitImage).observe($("preview"));

function showImage(image, size) {
	current = size;
	$("current-image").src = image.dataUrl;
	$("current-image").alt = image.name;
	$("current-stage").hidden = false;
	const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
	canvas.width = Math.max(1, Math.round(size.width * scale));
	canvas.height = Math.max(1, Math.round(size.height * scale));
	fitImage();
	draw();
}
function showStep(next) {
	step = next;
	$("workspace").className = `workspace ${step}`;
	$("question").textContent = step === "annotate" ? (session.mode === "choose" ? "수정할 곳이 있나요?" : session.mode === "report" ? editQuestion : session.question) : session.question;
	$("request-edit").hidden = step !== "report";
	$("submit").hidden = step === "report";
	$("cancel").hidden = step === "report";
	$("choices").hidden = !["choose", "report"].includes(step);
	$("comments").hidden = step !== "annotate";
	$("overlay").hidden = step !== "annotate";
	$("back").hidden = !["choose", "report"].includes(session.mode) || step !== "annotate";
	$("back").textContent = session.mode === "report" ? "보고로" : "시안 다시 선택";
	status("");
	fitImage();
	updateSubmit();
}
function renderRegions() {
	$("regions").replaceChildren();
	annotations.forEach((item, index) => {
		const row = document.createElement("li");
		const text = document.createElement("span");
		text.textContent = `${index + 1}. ${item.note}`;
		const remove = document.createElement("button");
		remove.type = "button";
		remove.textContent = "삭제";
		remove.setAttribute("aria-label", `${index + 1}번 영역 의견 삭제`);
		remove.onclick = () => { annotations.splice(index, 1); renderRegions(); draw(); };
		row.append(remove, text);
		$("regions").append(row);
	});
}
function chooseOption(option) {
	if (optionId && optionId !== option.id) {
		const hasDraft = annotations.length || selection || $("note").value.trim() || $("region-note").value.trim();
		if (hasDraft && !confirm("시안을 바꾸면 작성한 수정 의견이 지워집니다. 바꿀까요?")) {
			document.querySelectorAll('input[name="option"]').forEach((input) => { input.checked = input.value === optionId; });
			return;
		}
		annotations.length = 0;
		selection = null;
		$("note").value = "";
		$("region-note").value = "";
		renderRegions();
	}
	optionId = option.id;
	showImage(option.image, option.size);
}
async function decodeImage(image, dataUrl) {
	image.src = dataUrl;
	await image.decode();
	if (image.naturalWidth > 20000 || image.naturalHeight > 20000) throw new Error("이미지 한 변은 20,000픽셀 이하여야 합니다.");
	return { width: image.naturalWidth, height: image.naturalHeight };
}
async function buildChoices(entries, select) {
	const fragment = document.createDocumentFragment();
	for (const entry of entries) {
		const card = document.createElement("label");
		card.className = "choice";
		const image = document.createElement("img");
		image.alt = entry.label;
		entry.size = await decodeImage(image, entry.image.dataUrl);
		const caption = document.createElement("span");
		caption.className = "caption";
		const radio = document.createElement("input");
		radio.type = "radio"; radio.name = "option"; radio.value = entry.id;
		radio.onchange = () => select(entry);
		caption.append(radio, entry.label);
		card.append(image, caption);
		fragment.append(card);
	}
	return fragment;
}
async function loadSession() {
	try {
		const response = await fetch("/session", {
			headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		session = await response.json();
		if (session.mode === "report") {
			showStep("report");
			await refreshReport(session);
			loading = false;
			setTimeout(pollReport, 1000);
			return;
		}
		if (session.mode === "choose") {
			$("choices").replaceChildren(await buildChoices(session.options, chooseOption));
			const first = session.options[0];
			showImage(first.image, first.size);
		} else {
			const size = await decodeImage($("current-image"), session.current.dataUrl);
			showImage(session.current, size);
		}
		loading = false;
		finished = session.completed;
		showStep(session.mode);
		if (finished) status("이미 응답을 제출한 세션입니다.");
	} catch (error) { status(`화면을 불러오지 못했습니다: ${error.message}. 에이전트에게 다시 준비해 달라고 요청하세요.`); }
	finally { $("controls").disabled = finished; updateSubmit(); }
}

async function refreshReport(prepared = null) {
	if (step !== "report") return;
	const load = ++reportLoad;
	try {
		let update = prepared;
		if (!update) {
			const response = await fetch(`/session?revision=${reportRevision}`, {
				headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
			});
			if (response.status === 204) return;
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			update = await response.json();
		}
		const choices = await buildChoices(update.images, (entry) => {
			reportImageId = entry.id;
			showImage(entry.image, entry.size);
		});
		if (step !== "report" || load !== reportLoad) return;
		const selected = update.images.find((entry) => entry.id === reportImageId) ?? update.images[0];
		session = update;
		reportRevision = update.revision;
		reportImageId = selected.id;
		$("choices").replaceChildren(choices);
		document.querySelectorAll('input[name="option"]').forEach((input) => { input.checked = input.value === reportImageId; });
		showImage(selected.image, selected.size);
		$("question").textContent = update.question;
		status("");
	} catch (error) {
		if (step === "report" && load === reportLoad) status(`갱신 실패: ${error.message}. 기존 화면을 유지하며 다시 시도합니다.`);
	}
}
async function pollReport() {
	if (closed) return;
	await refreshReport();
	if (!closed) setTimeout(pollReport, 1000);
}
async function restoreReport() {
	editId = null;
	reportRevision = 0;
	showStep("report");
	await refreshReport();
}
$("request-edit").onclick = async () => {
	if (busy || loading) return;
	busy = true;
	$("controls").disabled = true;
	try {
		const response = await fetch("/edit", { method: "POST", headers: {
			Authorization: `Bearer ${token}`, "Content-Type": "application/json",
		}, body: JSON.stringify({ imageId: reportImageId, revision: reportRevision }), signal: AbortSignal.timeout(10000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const snapshot = await response.json();
		const size = await decodeImage(new Image(), snapshot.current.dataUrl);
		editId = snapshot.editId;
		editQuestion = snapshot.question;
		annotations.length = 0;
		selection = null;
		$("note").value = "";
		$("region-note").value = "";
		renderRegions();
		showStep("annotate");
		showImage(snapshot.current, size);
	} catch (error) {
		await refreshReport();
		status(`수정 화면을 열지 못했습니다: ${error.message}. 갱신된 이미지를 확인하고 다시 요청하세요.`);
	}
	finally { busy = false; $("controls").disabled = false; updateSubmit(); }
};
async function cancelReportEdit() {
	const hasDraft = annotations.length || selection || $("note").value.trim() || $("region-note").value.trim();
	if (hasDraft && !confirm("작성한 의견을 버리고 보고 화면으로 돌아갈까요?")) return;
	busy = true;
	$("controls").disabled = true;
	try {
		const response = await fetch("/edit", { method: "POST", headers: {
			Authorization: `Bearer ${token}`, "Content-Type": "application/json",
		}, body: JSON.stringify({ editId, cancel: true }), signal: AbortSignal.timeout(10000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		await restoreReport();
	} catch (error) { status(`보고 화면으로 돌아가지 못했습니다: ${error.message}. 의견은 유지됩니다.`); }
	finally { busy = false; $("controls").disabled = false; updateSubmit(); }
}

function point(event) {
	const rect = canvas.getBoundingClientRect();
	return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
		y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
}
canvas.onpointerdown = (event) => {
	if (loading || step !== "annotate" || finished || busy || !event.isPrimary || event.button !== 0) return;
	canvas.setPointerCapture(event.pointerId);
	drag = { ...point(event), pointerId: event.pointerId };
	selection = null;
	draw();
};
canvas.onpointermove = (event) => {
	if (!drag || drag.pointerId !== event.pointerId) return;
	const end = point(event);
	selection = { x: Math.min(drag.x, end.x), y: Math.min(drag.y, end.y),
		width: Math.abs(drag.x - end.x), height: Math.abs(drag.y - end.y) };
	draw();
};
canvas.onpointerup = (event) => {
	if (!drag || drag.pointerId !== event.pointerId) return;
	canvas.onpointermove(event);
	drag = null;
	if (selection && (selection.width < .002 || selection.height < .002)) selection = null;
	draw();
	if (selection) $("region-note").focus();
};
canvas.onpointercancel = () => { drag = null; selection = null; draw(); };
$("whole").onclick = () => { selection = { x: 0, y: 0, width: 1, height: 1 }; draw(); $("region-note").focus(); };
$("clear-selection").onclick = () => { selection = null; draw(); };
$("discard").onclick = () => { selection = null; $("region-note").value = ""; draw(); status(""); };
$("add").onclick = () => {
	const note = $("region-note").value.trim();
	if (!selection || !note) return status("선택한 영역의 수정 의견을 입력하세요.");
	if (annotations.length >= 100) return status("영역은 최대 100개까지 추가할 수 있습니다.");
	annotations.push({ ...selection, note });
	selection = null;
	$("region-note").value = "";
	renderRegions(); draw(); status("");
};
$("note").oninput = updateSubmit;
$("region-note").oninput = updateSubmit;
$("back").onclick = () => { if (session.mode === "report") void cancelReportEdit(); else showStep("choose"); };
async function submit(answer) {
	if (busy || finished) return;
	busy = true;
	$("controls").disabled = true;
	updateSubmit();
	try {
		const response = await fetch("/answer", { method: "POST", headers: {
			"Content-Type": "application/json", Authorization: `Bearer ${token}`,
		}, body: JSON.stringify(answer), signal: AbortSignal.timeout(30000) });
		const value = await response.json();
		if (!response.ok) throw new Error(value.error);
		if (session.mode === "report") await restoreReport();
		else {
			finished = true;
			status(answer.status === "cancelled" ? "취소했습니다." : "제출했습니다.");
		}
	} catch (error) { status(`전송 실패: ${error.message}. 입력은 유지됩니다.`); }
	finally { busy = false; $("controls").disabled = finished; updateSubmit(); }
}
$("feedback").onsubmit = (event) => {
	event.preventDefault();
	if (loading || busy || finished) return;
	if (step === "choose") {
		if (!optionId) return;
		showStep("annotate");
		return;
	}
	if (step === "report") return;
	if (selection || $("region-note").value.trim()) return status("작성 중인 영역 의견을 추가하거나 작성 취소를 눌러주세요.");
	void submit({ status: "submitted", imageSize: current, note: $("note").value.trim(), annotations,
		...(session.mode === "choose" ? { optionId } : session.mode === "report" ? { editId } : {}),
	});
};
$("cancel").onclick = () => {
	if (session?.mode === "report") { void cancelReportEdit(); return; }
	if (confirm("취소를 에이전트에 전달할까요?")) void submit({ status: "cancelled" });
};
if (!/^[a-f0-9]{48}$/.test(token)) {
	status("서버가 출력한 전체 URL(#뒤의 세션 키 포함)로 접속하세요.");
} else {
	void loadSession();
}
