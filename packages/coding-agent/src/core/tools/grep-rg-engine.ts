/** The grep engine that runs ripgrep and reads its `--json` stream. */

import { createInterface } from "node:readline";
import { spawn } from "child_process";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { GrepEngine, GrepEngineRequest, GrepHit } from "./grep-engine.ts";

/** The subset of ripgrep's `--json` messages this engine reads. */
interface RgJsonEvent {
	type: string;
	data?: {
		path?: { text?: string };
		line_number?: number;
		lines?: { text?: string };
		stats?: { matches?: number };
	};
}

/** Creates the ripgrep engine, downloading ripgrep on first use when it is not installed. */
export function createRgGrepEngine(): GrepEngine {
	return {
		async search(request, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const rgPath = await ensureTool("rg");
			if (!rgPath) throw new Error("ripgrep (rg) is not available and could not be downloaded");
			return runRipgrep(rgPath, request, signal);
		},
	};
}

function buildArgs(request: GrepEngineRequest): string[] {
	// --no-config: the tool contract (literal, glob, limit, ...) must not depend on
	// ambient user config like RIPGREP_CONFIG_PATH. Users can customize via bash or extensions.
	// --sort path: paging with skip needs the same order on every call.
	const args = ["--no-config", "--json", "--line-number", "--color=never", "--hidden", "--sort", "path"];
	if (request.ignoreCase) args.push("--ignore-case");
	if (request.literal) args.push("--fixed-strings");
	if (request.multiline) args.push("--multiline");
	// One match per file is enough to list it.
	if (request.mode === "files") args.push("--max-count", "1");
	for (const glob of request.globs) args.push("--glob", glob);
	args.push("--", request.pattern, ...request.paths);
	return args;
}

function runRipgrep(rgPath: string, request: GrepEngineRequest, signal: AbortSignal | undefined): Promise<GrepHit[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(rgPath, buildArgs(request), { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		const hits: GrepHit[] = [];
		let stderr = "";
		let aborted = false;
		let killedDueToLimit = false;

		const stopChild = () => {
			if (!child.killed) child.kill();
		};
		const onAbort = () => {
			aborted = true;
			stopChild();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => {
			rl.close();
			signal?.removeEventListener("abort", onAbort);
		};
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const addHit = (hit: GrepHit) => {
			hits.push(hit);
			if (hits.length >= request.maxHits) {
				killedDueToLimit = true;
				stopChild();
			}
		};
		rl.on("line", (line) => {
			if (!line.trim() || killedDueToLimit) return;
			let event: RgJsonEvent;
			try {
				event = JSON.parse(line) as RgJsonEvent;
			} catch {
				return;
			}
			const filePath = event.data?.path?.text;
			if (!filePath) return;
			if (request.mode === "count") {
				const count = event.data?.stats?.matches;
				if (event.type === "end" && count) addHit({ type: "count", filePath, count });
				return;
			}
			if (event.type !== "match") return;
			if (request.mode === "files") {
				const last = hits.at(-1);
				if (last?.filePath !== filePath) addHit({ type: "file", filePath });
				return;
			}
			const lineNumber = event.data?.line_number;
			if (typeof lineNumber === "number") {
				addHit({ type: "match", filePath, lineNumber, lineText: event.data?.lines?.text });
			}
		});

		child.on("error", (error) => {
			cleanup();
			reject(new Error(`Failed to run ripgrep: ${error.message}`));
		});
		child.on("close", (code) => {
			cleanup();
			if (aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			if (!killedDueToLimit && code !== 0 && code !== 1) {
				reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
				return;
			}
			resolve(hits);
		});
	});
}
