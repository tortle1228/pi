/** The grep engine that searches in-process through the native addon built from `native/grep`. */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { getNativeGrepAddonPath } from "../../config.ts";
import type { GrepEngine, GrepEngineRequest, GrepHit } from "./grep-engine.ts";

/** The addon's exports, as declared in `native/grep/src/lib.rs`. */
interface NativeGrepAddon {
	search(request: GrepEngineRequest, token: NativeCancelToken): Promise<NativeGrepHit[]>;
	CancelToken: new () => NativeCancelToken;
}

interface NativeCancelToken {
	cancel(): void;
}

/** A hit as the addon returns it: `type` decides which optional fields are set. */
interface NativeGrepHit {
	type: string;
	filePath: string;
	lineNumber?: number;
	lineText?: string;
	count?: number;
}

const require = createRequire(import.meta.url);

/**
 * Creates the native engine, or returns undefined when the addon for this platform is not built or does not load,
 * for example a glibc build on a musl system.
 */
export function createNativeGrepEngine(addonPath = getNativeGrepAddonPath()): GrepEngine | undefined {
	const addon = loadAddon(addonPath);
	if (!addon) return undefined;
	return {
		async search(request, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const token = new addon.CancelToken();
			const pending = addon.search(request, token);
			// The search cannot be interrupted mid-file: on abort, reject now and let it stop at the next file.
			pending.catch(() => {});
			let onAbort: (() => void) | undefined;
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => {
					token.cancel();
					reject(new Error("Operation aborted"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });
			});
			try {
				return (await Promise.race([pending, aborted])).map(toGrepHit);
			} finally {
				if (onAbort) signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

function loadAddon(addonPath: string): NativeGrepAddon | undefined {
	if (!existsSync(addonPath)) return undefined;
	try {
		// Cast: the shape is fixed by native/grep/src/lib.rs, built from this repository.
		return require(addonPath) as NativeGrepAddon;
	} catch {
		return undefined;
	}
}

function toGrepHit(hit: NativeGrepHit): GrepHit {
	switch (hit.type) {
		case "file":
			return { type: "file", filePath: hit.filePath };
		case "count":
			return { type: "count", filePath: hit.filePath, count: hit.count ?? 0 };
		default:
			return { type: "match", filePath: hit.filePath, lineNumber: hit.lineNumber ?? 0, lineText: hit.lineText };
	}
}
