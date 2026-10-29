import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getNativeGrepAddonPath } from "../src/config.ts";
import type { GrepEngineRequest } from "../src/core/tools/grep-engine.ts";
import { createNativeGrepEngine } from "../src/core/tools/grep-native-engine.ts";
import { createRgGrepEngine } from "../src/core/tools/grep-rg-engine.ts";

// Built by `npm run build:native-grep`; without it these tests are skipped and the grep tool uses ripgrep.
const native = createNativeGrepEngine();
const rg = createRgGrepEngine();

const files: Record<string, string | Buffer> = {
	"a.txt": "needle one\nnothing\nNEEDLE two needle\n",
	"a-b.txt": "needle in a-b\n",
	"a/inner.txt": "needle inside a\n",
	"a/deep/z.ts": "function f() {\n  return needle;\n}\n",
	"b/index.ts": "needle ts\n",
	"b/index.test.ts": "needle test\n",
	"crlf.txt": "needle crlf\r\nnext\r\n",
	".hidden/secret.txt": "needle hidden\n",
	"ignored/skip.txt": "needle ignored\n",
	"rgignored/skip.txt": "needle rgignored\n",
	"binary.dat": Buffer.from("needle before\u0000binary\nneedle after\n"),
	"special.txt": "a.b(c) needle\na-b-c\n",
	".gitignore": "ignored/\n",
	".rgignore": "rgignored/\n",
};

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-grep-native-"));
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), content);
	}
	// .gitignore applies only inside a git repository, for both engines.
	spawnSync("git", ["init", "-q"], { cwd: root });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A request with defaults; `paths` are relative to the fixture root, which exists only once the tests run. */
function request(overrides: Partial<GrepEngineRequest>): GrepEngineRequest {
	const { paths = ["."], ...rest } = overrides;
	return {
		pattern: "needle",
		paths: paths.map((path) => join(root, path)),
		globs: [],
		ignoreCase: false,
		literal: false,
		multiline: false,
		mode: "content",
		maxHits: 1000,
		...rest,
	};
}

describe.skipIf(!native)("native grep engine", () => {
	it("finds the addon at the configured path", () => {
		expect(existsSync(getNativeGrepAddonPath())).toBe(true);
	});

	describe("matches ripgrep", () => {
		it.each<[string, Partial<GrepEngineRequest>]>([
			["content in path order", {}],
			["case-insensitive search", { ignoreCase: true }],
			["literal patterns", { pattern: "a.b(c)", literal: true }],
			["regex patterns", { pattern: "a.b" }],
			["positive and negative globs", { globs: ["*.ts", "!*.test.ts"] }],
			["files mode", { mode: "files" }],
			["count mode with several matches per line", { mode: "count", ignoreCase: true }],
			["multiline matches", { pattern: "f\\(\\) \\{\\n  return", multiline: true }],
			["a hit limit", { maxHits: 3 }],
			["several roots in the given order", { paths: ["b", "a"] }],
			["a file named directly, ignoring globs", { paths: ["a.txt"], globs: ["*.md"] }],
			["a binary file named directly", { paths: ["binary.dat"] }],
			["no matches", { pattern: "absent" }],
		])("for %s", async (_name, overrides) => {
			const req = request(overrides);
			const expected = await rg.search(req);
			expect(await native!.search(req)).toEqual(expected);
		});

		it("skips ignored and walked binary files and includes hidden ones", async () => {
			const paths = (await native!.search(request({ mode: "files" }))).map((hit) =>
				hit.filePath.slice(root.length + 1),
			);
			expect(paths).toContain(".hidden/secret.txt");
			expect(paths).not.toContain("ignored/skip.txt");
			expect(paths).not.toContain("rgignored/skip.txt");
			expect(paths).not.toContain("binary.dat");
		});

		it("keeps CRLF line ends in the line text", async () => {
			const [hit] = await native!.search(request({ paths: ["crlf.txt"] }));
			expect(hit).toEqual({
				type: "match",
				filePath: join(root, "crlf.txt"),
				lineNumber: 1,
				lineText: "needle crlf\r\n",
			});
		});
	});

	it("rejects an invalid pattern", async () => {
		await expect(native!.search(request({ pattern: "(" }))).rejects.toThrow(/regex parse error/);
	});

	it("rejects an aborted search", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(native!.search(request({}), controller.signal)).rejects.toThrow("Operation aborted");

		const running = new AbortController();
		const pending = native!.search(request({}), running.signal);
		running.abort();
		await expect(pending).rejects.toThrow("Operation aborted");
	});
});

describe("native grep engine loading", () => {
	it("returns undefined when the addon is missing", () => {
		expect(createNativeGrepEngine(join(tmpdir(), "missing", "pi_grep.node"))).toBeUndefined();
	});

	it("returns undefined when the addon does not load", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-grep-broken-"));
		const broken = join(dir, "pi_grep.node");
		writeFileSync(broken, "not a shared library");
		try {
			expect(createNativeGrepEngine(broken)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
