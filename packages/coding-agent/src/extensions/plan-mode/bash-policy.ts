/** Conservative inspection policy for shell commands; not an OS sandbox. */

interface Word {
	/** Text as written, quotes included. */
	raw: string;
	/** Text the command receives. */
	value: string;
	redirect: boolean;
	/** Output operator whose next word is a file, used only by mutation inspection. */
	output?: boolean;
	/** Contains an unquoted * ? [ ], which the shell expands into file names. */
	glob: boolean;
}

interface Segment {
	words: Word[];
	separator?: string;
}

const OPERATORS = ["&&", "||", ";", "|"];
const REDIRECTS = ["2>/dev/null", "2>&1"];
// Unquoted globs are allowed only for programs without option-style side effects, see toSafeCommand.
const UNQUOTED_REJECTED = /[$`\\(){}<>#\n\r]/;
const GLOB_CHARS = /[*?[\]]/;
const isBoundary = (char: string | undefined) => char === undefined || " \t;|&\n".includes(char);

function parse(source: string, inspectWrites = false): Segment[] | undefined {
	const segments: Segment[] = [];
	let words: Word[] = [];
	let i = 0;
	while (i < source.length) {
		const char = source[i];
		if (char === " " || char === "\t") {
			i++;
			continue;
		}
		if (char === "\n" && inspectWrites) {
			if (words.length > 0) {
				segments.push({ words, separator: "\n" });
				words = [];
			}
			i++;
			continue;
		}
		const operator = OPERATORS.find((candidate) => source.startsWith(candidate, i));
		if (operator) {
			if (words.length === 0) return undefined;
			segments.push({ words, separator: operator });
			words = [];
			i += operator.length;
			continue;
		}
		if (char === "&") return undefined;
		const redirect = REDIRECTS.find((r) => source.startsWith(r, i) && isBoundary(source[i + r.length]));
		if (redirect) {
			words.push({ raw: redirect, value: redirect, redirect: true, glob: false });
			i += redirect.length;
			continue;
		}
		if (inspectWrites) {
			const output = /^(?:\d*)(?:>>|>\||>)(?:&(?:\d+|-))?/.exec(source.slice(i))?.[0];
			if (output) {
				words.push({ raw: output, value: output, redirect: true, output: !output.includes("&"), glob: false });
				i += output.length;
				continue;
			}
		}
		// Only ~ and ~/x expand predictably; HEAD~3 stays literal because the tilde is not leading.
		if (char === "~" && source[i + 1] !== "/" && !isBoundary(source[i + 1])) return undefined;

		const start = i;
		let value = "";
		let glob = false;
		while (!isBoundary(source[i]) && !(inspectWrites && source[i] === ">")) {
			const c = source[i];
			if (c === "'") {
				const close = source.indexOf("'", i + 1);
				if (close < 0) return undefined;
				value += source.slice(i + 1, close);
				i = close + 1;
			} else if (c === '"') {
				i++;
				while (source[i] !== '"') {
					if (i >= source.length || source[i] === "$" || source[i] === "`") return undefined;
					if (source[i] === "\\") i++;
					if (i >= source.length) return undefined;
					value += source[i];
					i++;
				}
				i++;
			} else if (UNQUOTED_REJECTED.test(c)) {
				return undefined;
			} else {
				if (GLOB_CHARS.test(c)) glob = true;
				value += c;
				i++;
			}
		}
		if (i === start) return undefined;
		words.push({ raw: source.slice(start, i), value, redirect: false, glob });
	}
	if (words.length === 0) return inspectWrites && segments.at(-1)?.separator === ";" ? segments : undefined;
	segments.push({ words });
	return segments;
}

interface DeniedOptions {
	/** Single-letter options, also found inside clusters such as -nz. */
	short?: string;
	/** Prefixes, because GNU getopt and git accept abbreviated long options (--outp=x). */
	long?: string[];
}

function isDenied(arg: string, { short = "", long = [] }: DeniedOptions): boolean {
	if (long.some((prefix) => arg.startsWith(prefix))) return true;
	return /^-[^-]/.test(arg) && [...arg.slice(1)].some((letter) => short.includes(letter));
}

const UNRESTRICTED = new Set(
	"cat head wc ls pwd which du df stat basename dirname realpath readlink cut tr nl diff cmp sha256sum md5sum jq uname whoami id echo printf true grep cd".split(
		" ",
	),
);
const DENIED_OPTIONS: Record<string, DeniedOptions> = {
	tail: { short: "fF", long: ["--f"] },
	find: { long: ["-exec", "-ok", "-delete", "-fls", "-fprint"] },
	fd: { short: "xX", long: ["--exec"] },
	rg: { short: "z", long: ["--pre", "--hostname-bin", "--search-zip"] },
	tree: { short: "o" },
	file: { short: "C", long: ["--comp"] },
	date: { short: "s", long: ["--s"] },
};
const VERSION_COMMANDS = new Set(["node", "npm", "python", "python3", "java", "uv", "cargo", "go", "rustc"]);
// Short forms only where they print the version: python -v is verbose mode and runs code from stdin.
const SHORT_VERSION_FLAGS: Record<string, string> = { node: "-v", npm: "-v", java: "-version" };
// curl is allowed only as a plain read: no output files, request bodies, config files or non-HTTP schemes.
const CURL_FLAGS = /^(?:-[sSLIif]+|--(?:silent|show-error|location|head|include|fail|compressed))$/;
const CURL_VALUE_FLAGS = new Set(["-H", "--header", "-A", "--user-agent", "-m", "--max-time"]);

function isSafeCurl(args: string[]): boolean {
	let urls = 0;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (CURL_VALUE_FLAGS.has(arg)) {
			const value = args[++i];
			// A leading @ makes curl read the value from a local file.
			if (value === undefined || value.startsWith("@")) return false;
		} else if (/^https?:\/\//.test(arg)) {
			urls++;
		} else if (!CURL_FLAGS.test(arg)) {
			return false;
		}
	}
	return urls > 0;
}

const UNIQ_FLAGS = /^-[cdDiuz]+$/;

function isSafeProgram(name: string, args: string[]): boolean {
	if (UNRESTRICTED.has(name)) return true;
	const denied = DENIED_OPTIONS[name];
	if (denied) return !args.some((arg) => isDenied(arg, denied));
	if (VERSION_COMMANDS.has(name)) {
		return args.length === 1 && (args[0] === "--version" || args[0] === SHORT_VERSION_FLAGS[name]);
	}
	if (name === "curl") return isSafeCurl(args);
	if (name === "sort") return args.every((arg) => !arg.startsWith("-") || /^-[bdfghinrsuV]*(?:[kt].*)?$/.test(arg));
	if (name === "sed") {
		return args[0] === "-n" && /^\d+(?:,\d+)?p$/.test(args[1] ?? "") && !args.slice(2).some((a) => a.startsWith("-"));
	}
	if (name === "uniq") {
		// A second positional argument is uniq's output file, and "-" counts as a positional argument.
		const positional = args.filter((arg) => !UNIQ_FLAGS.test(arg));
		return positional.length <= 1 && positional.every((arg) => arg === "-" || !arg.startsWith("-"));
	}
	return false;
}

const GIT_DENIED: DeniedOptions = { short: "O", long: ["--ou", "--ext", "--te", "--op"] };
const GIT_READ_SUBCOMMANDS = new Set(
	"status diff log show blame shortlog describe merge-base rev-parse ls-files ls-tree grep".split(" "),
);
const GIT_RESTRICTED_SUBCOMMANDS: Record<string, (args: string[]) => boolean> = {
	branch: (args) => {
		const flags = args.filter((arg) => arg.startsWith("-"));
		// Without a listing flag, a positional argument creates a branch.
		const lists = flags.some((flag) => /^--(?:list|contains|merged|no-merged)(?:=|$)/.test(flag));
		return (
			flags.every((flag) => /^(?:-[arv]+|--(?:show-current|list|contains|merged|no-merged)(?:=.*)?)$/.test(flag)) &&
			(lists || flags.length === args.length)
		);
	},
	remote: (args) => args.length === 0 || (args.length === 1 && args[0] === "-v") || args[0] === "get-url",
	tag: (args) => (args[0] === "-l" || args[0] === "--list") && !args.slice(1).some((arg) => arg.startsWith("-")),
	stash: (args) => args[0] === "list",
	"cat-file": (args) => args.length === 2 && /^-[pts]$/.test(args[0]),
};
const GIT_SAFETY_FLAGS: Record<string, string> = {
	diff: " --no-ext-diff --no-textconv",
	log: " --no-ext-diff --no-textconv",
	show: " --no-ext-diff --no-textconv",
	blame: " --no-textconv",
};

/**
 * The git command with the helpers git has flags for turned off, or undefined when it is not read-only.
 * shortcut: filter.*.clean in .git/config still runs on status and diff, use an OS sandbox for untrusted repositories.
 */
function toSafeGit(words: Word[]): string | undefined {
	const globals: string[] = [];
	let i = 1;
	while (words[i]?.value.startsWith("-")) {
		const option = words[i];
		if (option.value === "--no-pager") {
			i++;
		} else if (option.value === "-C" && words[i + 1] && !words[i + 1].redirect) {
			globals.push(option.raw, words[i + 1].raw);
			i += 2;
		} else {
			return undefined;
		}
	}
	const subcommand = words[i];
	if (!subcommand || subcommand.redirect) return undefined;
	const rest = words.slice(i + 1);
	const args = rest.filter((word) => !word.redirect).map((word) => word.value);
	if (args.some((arg) => isDenied(arg, GIT_DENIED))) return undefined;
	const restricted = GIT_RESTRICTED_SUBCOMMANDS[subcommand.value];
	if (restricted ? !restricted(args) : !GIT_READ_SUBCOMMANDS.has(subcommand.value)) return undefined;
	return [
		"git --no-pager --no-optional-locks -c core.fsmonitor=false",
		...globals,
		`${subcommand.raw}${GIT_SAFETY_FLAGS[subcommand.value] ?? ""}`,
		...rest.map((word) => word.raw),
	].join(" ");
}

const MUTATING_PROGRAMS = new Set(
	"rm rmdir mv cp install touch mkdir ln truncate tee chmod chown chgrp sudo".split(" "),
);
const MUTATING_SUBCOMMANDS: Record<string, readonly string[]> = {
	git: "add commit reset restore checkout switch clean merge rebase cherry-pick revert am apply fetch pull push clone init gc prune".split(
		" ",
	),
	npm: "install i ci uninstall remove update publish unpublish".split(" "),
	pip: ["install", "uninstall"],
	pip3: ["install", "uninstall"],
	uv: ["sync", "add", "remove"],
	terraform: ["apply", "destroy", "import"],
	kubectl: "apply create delete replace patch edit scale set rollout exec".split(" "),
};
const GH_MUTATIONS: Record<string, readonly string[]> = {
	pr: ["create", "merge", "close", "reopen", "edit"],
	issue: ["create", "close", "reopen", "edit"],
	release: ["create", "delete", "edit", "upload"],
	repo: ["create", "delete"],
	workflow: ["run"],
	run: ["cancel", "rerun"],
};
const LEADING_OPTIONS: Record<string, { values: readonly string[]; flags: readonly string[] }> = {
	git: { values: ["-C", "-c", "--git-dir", "--work-tree"], flags: ["--no-pager", "--no-optional-locks"] },
	npm: {
		values: ["--prefix", "--workspace", "-w", "--registry", "--cache", "--userconfig"],
		flags: ["-g", "--global", "--ignore-scripts", "--offline", "--silent"],
	},
	pip: {
		values: ["--python", "--proxy", "--timeout", "--retries", "--index-url", "--cache-dir", "--log"],
		flags: [
			"--require-virtualenv",
			"--isolated",
			"--no-input",
			"--disable-pip-version-check",
			"--no-cache-dir",
			"-q",
			"--quiet",
			"-v",
			"--verbose",
		],
	},
	uv: {
		values: ["--directory", "--project", "--config-file", "--cache-dir", "--color"],
		flags: ["--offline", "--no-config", "--no-cache", "-q", "--quiet", "-v", "--verbose"],
	},
	terraform: { values: ["-chdir"], flags: [] },
	kubectl: {
		values: [
			"--context",
			"--namespace",
			"-n",
			"--kubeconfig",
			"--cluster",
			"--user",
			"--server",
			"-s",
			"--token",
			"--as",
			"--as-group",
			"--request-timeout",
		],
		flags: ["--insecure-skip-tls-verify", "--warnings-as-errors"],
	},
	gh: { values: ["--repo", "-R", "--hostname"], flags: [] },
};
const FIND_VALUE_PREDICATES = new Set(
	"-name -iname -path -ipath -wholename -iwholename -regex -iregex -lname -ilname -printf -type -xtype -user -group -uid -gid -size -mtime -mmin -atime -amin -ctime -cmin -newer -newermt -samefile -inum -links -perm -maxdepth -mindepth -regextype".split(
		" ",
	),
);

/** A detected mutation, not a proof that commands returning undefined are read-only. */
export function getMutationReason(command: string): string | undefined {
	// shortcut: scripts and unsupported shell syntax remain unclassified; use an OS sandbox for enforced read-only execution.
	const segments = parse(command.trim(), true);
	if (!segments) return undefined;
	for (const { words } of segments) {
		const args: string[] = [];
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (word.output) {
				const target = words[++i];
				if (!target || target.redirect) return undefined;
				if (target.value !== "/dev/null") return "file output redirection";
			} else if (!word.redirect) {
				args.push(word.value);
			}
		}
		const name = args.shift()?.split("/").pop();
		if (!name) continue;
		if (MUTATING_PROGRAMS.has(name)) return `${name}: file or system mutation`;
		const optionProgram = name === "pip3" ? "pip" : name;
		if (Object.hasOwn(LEADING_OPTIONS, optionProgram)) {
			const { values, flags } = LEADING_OPTIONS[optionProgram];
			while (args[0]?.startsWith("-")) {
				const option = args[0];
				if (option === "--") {
					args.shift();
					break;
				}
				if (values.includes(option)) args.splice(0, 2);
				else if (
					flags.includes(option.split("=")[0]) ||
					values.some(
						(value) => option.startsWith(`${value}=`) || (/^-[^-]$/.test(value) && option.startsWith(value)),
					)
				)
					args.shift();
				else break;
			}
		}
		if (name === "git") {
			const restricted = GIT_RESTRICTED_SUBCOMMANDS[args[0]];
			if (["branch", "tag", "remote", "stash"].includes(args[0]) && restricted && !restricted(args.slice(1))) {
				return `git ${args[0]}: repository mutation`;
			}
		}
		if (Object.hasOwn(MUTATING_SUBCOMMANDS, name) && MUTATING_SUBCOMMANDS[name].includes(args[0])) {
			return `${name} ${args[0]}: state mutation`;
		}
		if (name === "uv" && args[0] === "pip" && ["install", "uninstall", "sync"].includes(args[1])) {
			return "uv pip: package mutation";
		}
		if (name === "gh" && Object.hasOwn(GH_MUTATIONS, args[0]) && GH_MUTATIONS[args[0]].includes(args[1])) {
			return `gh ${args[0]} ${args[1]}: remote mutation`;
		}
		if (name === "sed") {
			const options = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
			if (options.some((arg) => isDenied(arg, { short: "i", long: ["--in-place"] })))
				return "sed: file write option";
		}
		if (name === "find") {
			for (let i = 0; i < args.length; i++) {
				if (FIND_VALUE_PREDICATES.has(args[i])) i++;
				else if (["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(args[i]))
					return "find: file write option";
			}
		}
		if (name === "sort") {
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === "--") break;
				if (arg.startsWith("--outp")) return "sort: file write option";
				if (
					[
						"--field-separator",
						"--key",
						"--buffer-size",
						"--temporary-directory",
						"--sort",
						"--parallel",
						"--batch-size",
						"--compress-program",
						"--random-source",
						"--files0-from",
					].includes(arg)
				)
					i++;
				else if (/^-[^-]/.test(arg)) {
					for (let j = 1; j < arg.length; j++) {
						if (arg[j] === "o") return "sort: file write option";
						if ("ktST".includes(arg[j])) {
							if (j === arg.length - 1) i++;
							break;
						}
					}
				}
			}
		}
		if (name === "uniq") {
			let positional = 0;
			let endOptions = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (endOptions || arg === "-" || !arg.startsWith("-")) positional++;
				else if (arg === "--") endOptions = true;
				else if (
					/^-(?:[cdDiuz]*[fsw])$/.test(arg) ||
					["--skip-fields", "--skip-chars", "--check-chars"].includes(arg)
				)
					i++;
			}
			if (positional > 1) return "uniq: output file";
		}
		if (name === "curl") {
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === "--") break;
				// Header/auth values are data, not curl options.
				if (
					[
						"-H",
						"--header",
						"-A",
						"--user-agent",
						"-m",
						"--max-time",
						"-u",
						"--user",
						"-e",
						"--referer",
						"-x",
						"--proxy",
					].includes(arg)
				) {
					i++;
					continue;
				}
				if (isDenied(arg, { long: ["--output", "--remote-name", "--upload-file", "--data", "--form", "--json"] })) {
					return "curl: file output or upload";
				}
				if (arg === "--request" || arg.startsWith("--request=")) {
					const method = arg === "--request" ? args[++i] : arg.slice("--request=".length);
					if (method && !["GET", "HEAD", "OPTIONS"].includes(method)) return "curl: mutating HTTP method";
				} else if (/^-[^-]/.test(arg)) {
					for (let j = 1; j < arg.length; j++) {
						const flag = arg[j];
						if ("oOTdF".includes(flag)) return "curl: file output or upload";
						if ("HAmuexX".includes(flag)) {
							const value = arg.slice(j + 1) || args[++i];
							if (flag === "X" && value && !["GET", "HEAD", "OPTIONS"].includes(value))
								return "curl: mutating HTTP method";
							break;
						}
					}
				}
			}
		}
	}
	return undefined;
}

/**
 * The command to run when every part of it only inspects, or undefined when it needs the user's approval.
 * Git commands come back rewritten to turn off helpers from repository configuration (see toSafeGit for the limit).
 */
export function toSafeCommand(command: string): string | undefined {
	const segments = parse(command.trim());
	if (!segments) return undefined;
	let result = "";
	for (const { words, separator } of segments) {
		const [program, ...rest] = words;
		if (program.redirect || program.glob) return undefined;
		// A file named --pre=x would expand into an option, so only programs without dangerous options may take globs.
		if (words.some((word) => word.glob) && !UNRESTRICTED.has(program.value)) return undefined;
		let safe: string | undefined;
		if (program.value === "git") {
			safe = toSafeGit(words);
		} else if (
			isSafeProgram(
				program.value,
				rest.filter((word) => !word.redirect).map((word) => word.value),
			)
		) {
			safe = words.map((word) => word.raw).join(" ");
		}
		if (safe === undefined) return undefined;
		result += separator ? `${safe} ${separator} ` : safe;
	}
	return result;
}
