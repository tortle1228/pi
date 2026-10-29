// A fake language server for the LSP extension tests. It reports an error on every line that contains "ERROR".
// The first argument selects how:
//   push       publishDiagnostics with the document version (default)
//   unversioned publishDiagnostics without a version
//   stale      publishes a report for the previous version first, then the real one
//   pull       advertises diagnosticProvider and answers textDocument/diagnostic
//   silent     never reports
//   crash      exits on the first didChange

const mode = process.argv[2] ?? "push";
const documents = new Map();
let buffer = Buffer.alloc(0);

function send(message) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}

function diagnosticsFor(text) {
	return text.split("\n").flatMap((line, index) =>
		line.includes("ERROR")
			? [{ range: { start: { line: index, character: line.indexOf("ERROR") } }, severity: 1, message: "found ERROR", source: "fake", code: 1 }]
			: [],
	);
}

function publish(uri, version, text) {
	send({
		method: "textDocument/publishDiagnostics",
		params: { uri, ...(mode === "unversioned" ? {} : { version }), diagnostics: diagnosticsFor(text) },
	});
}

function changed(uri, version, text) {
	const previous = documents.get(uri);
	documents.set(uri, { version, text });
	if (mode === "silent" || mode === "pull") return;
	if (mode === "stale" && previous) publish(uri, previous.version, previous.text);
	publish(uri, version, text);
}

function handle(message) {
	const { id, method, params } = message;
	switch (method) {
		case "initialize":
			send({ id, result: { capabilities: mode === "pull" ? { diagnosticProvider: {} } : {} } });
			// Servers ask for configuration during startup; the client must answer.
			send({ id: "config-1", method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
			return;
		case "textDocument/didOpen":
			changed(params.textDocument.uri, params.textDocument.version, params.textDocument.text);
			return;
		case "textDocument/didChange":
			if (mode === "crash") process.exit(1);
			changed(params.textDocument.uri, params.textDocument.version, params.contentChanges[0].text);
			return;
		case "textDocument/diagnostic":
			send({ id, result: { kind: "full", items: diagnosticsFor(documents.get(params.textDocument.uri)?.text ?? "") } });
			return;
		case "shutdown":
			send({ id, result: null });
			return;
		case "exit":
			process.exit(0);
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
		if (buffer.length < headerEnd + 4 + length) return;
		const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
		buffer = buffer.subarray(headerEnd + 4 + length);
		handle(JSON.parse(body));
	}
});
