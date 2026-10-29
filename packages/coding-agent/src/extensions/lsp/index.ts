/**
 * Language server diagnostics after edits, as an extension. The CLI loads it as a built-in extension; SDK users add
 * `createLspExtension()` to their extension factories.
 *
 * With the `lsp.enabled` setting on, every successful `edit` and `write` result gets the errors and warnings that the
 * file's language server reports for the new content, so the model sees them in the same turn. Servers start on first
 * use and stop when the session ends.
 */

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { type ExtensionFactory, isEditToolResult, isWriteToolResult } from "../../core/extensions/types.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import type { Diagnostic } from "./lsp-client.ts";
import { type CheckOutcome, LspManager, type LspManagerOptions } from "./lsp-manager.ts";
import { findServer, resolveServers } from "./servers.ts";

export interface LspExtensionOptions extends LspManagerOptions {}

/** Diagnostics listed per result; the rest are counted. */
const MAX_LISTED_DIAGNOSTICS = 20;

export function createLspExtension(options: LspExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		const manager = new LspManager(options);
		pi.on("tool_result", async (event, ctx) => {
			const settings = pi.getSettings().lsp;
			if (!settings?.enabled || event.isError) return;
			if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
			// Result events type their input loosely; edit and write validated `path` as a string before running.
			const inputPath = event.input.path;
			if (typeof inputPath !== "string") return;
			const filePath = resolveToCwd(inputPath, ctx.cwd);
			const server = findServer(resolveServers(settings.servers), filePath);
			if (!server) return;
			let text: string;
			try {
				text = await readFile(filePath, "utf-8");
			} catch {
				return;
			}
			const block = formatOutcome(await manager.check(server, ctx.cwd, filePath, text), relative(ctx.cwd, filePath));
			if (!block) return;
			// Replacing content drops structuredContent unless it is passed on.
			return {
				content: [...event.content, { type: "text", text: block }],
				structuredContent: event.structuredContent,
			};
		});
		pi.on("session_shutdown", () => manager.stopAll());
	};
}

export default createLspExtension();

/** The text appended to the result, or undefined when there is nothing to report. */
function formatOutcome(outcome: CheckOutcome, displayPath: string): string | undefined {
	switch (outcome.kind) {
		case "skipped":
			return undefined;
		case "unavailable":
			return `\n\n[LSP ${outcome.server}: ${outcome.message}. Install it, or turn it off with lsp.servers.${outcome.server}.disabled.]`;
		case "timeout":
			return `\n\n[LSP ${outcome.server}: no diagnostics for ${displayPath} within ${outcome.waitedMs / 1000}s; errors may be unreported.]`;
		case "exited":
			return `\n\n[LSP ${outcome.server} exited while checking ${displayPath}; errors may be unreported. It starts again on the next edit.]`;
		case "diagnostics":
			return formatDiagnostics(outcome.server, displayPath, outcome.diagnostics);
	}
}

function formatDiagnostics(server: string, displayPath: string, diagnostics: Diagnostic[]): string | undefined {
	// Information and hints are noise for the model; only problems are reported, and a clean file adds nothing.
	const problems = diagnostics
		.filter((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning")
		.sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === "error" ? -1 : 1));
	if (problems.length === 0) return undefined;
	const errors = problems.filter((diagnostic) => diagnostic.severity === "error").length;
	const warnings = problems.length - errors;
	const counts = [plural(errors, "error"), plural(warnings, "warning")].filter(Boolean).join(" and ");
	const lines = problems.slice(0, MAX_LISTED_DIAGNOSTICS).map((diagnostic) => {
		const code = diagnostic.code ? ` [${diagnostic.source ? `${diagnostic.source} ` : ""}${diagnostic.code}]` : "";
		const message = diagnostic.message.replace(/\s*\n\s*/g, " ");
		return `${displayPath}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}${code}: ${message}`;
	});
	if (problems.length > MAX_LISTED_DIAGNOSTICS) lines.push(`... and ${problems.length - MAX_LISTED_DIAGNOSTICS} more`);
	return `\n\nLSP ${server} found ${counts} in ${displayPath}:\n${lines.join("\n")}`;
}

function plural(count: number, noun: string): string {
	return count === 0 ? "" : `${count} ${noun}${count === 1 ? "" : "s"}`;
}
