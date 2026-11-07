/** Conservative inspection policy for shell commands; not an OS sandbox. */

interface Word {
	/** Text as written, quotes included. */
	raw: string;
	/** Text the command receives. */
	value: string;
	redirect: boolean;
}

interface Segment {
	words: Word[];
	separator?: string;
}

const OPERATORS = ["&&", "||", ";", "|"];
const REDIRECTS = ["2>/dev/null", "2>&1"];
// Unquoted globs are rejected too: a file named --pre=x would expand into an option.
const UNQUOTED_REJECTED = /[$`\\(){}<>#*?[\]\n\r]/;
const isBoundary = (char: string | undefined) => char === undefined || " \t;|&".includes(char);

function parse(source: string): Segment[] | undefined {
	const segments: Segment[] = [];
	let words: Word[] = [];
	let i = 0;
	while (i < source.length) {
		const char = source[i];
		if (char === " " || char === "\t") {
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
			words.push({ raw: redirect, value: redirect, redirect: true });
			i += redirect.length;
			continue;
		}
		// Only ~ and ~/x expand predictably; HEAD~3 stays literal because the tilde is not leading.
		if (char === "~" && source[i + 1] !== "/" && !isBoundary(source[i + 1])) return undefined;

		const start = i;
		let value = "";
		while (!isBoundary(source[i])) {
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
				value += c;
				i++;
			}
		}
		words.push({ raw: source.slice(start, i), value, redirect: false });
	}
	if (words.length === 0) return undefined;
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
const UNIQ_FLAGS = /^-[cdDiuz]+$/;

function isSafeProgram(name: string, args: string[]): boolean {
	if (UNRESTRICTED.has(name)) return true;
	const denied = DENIED_OPTIONS[name];
	if (denied) return !args.some((arg) => isDenied(arg, denied));
	if (VERSION_COMMANDS.has(name)) {
		return args.length === 1 && (args[0] === "--version" || args[0] === SHORT_VERSION_FLAGS[name]);
	}
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
		if (program.redirect) return undefined;
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
