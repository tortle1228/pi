/**
 * Masks credentials in streamed shell output before the output is stored, displayed, or sent to the model.
 *
 * Only anchored credential shapes are matched (vendor token prefixes, JWTs, bearer tokens, URL passwords, PEM
 * private keys). There are no generic keyword rules such as `*_TOKEN=value`, so identifiers like
 * `token_expiry_seconds` stay readable. Output is released as it arrives, except for a trailing piece that may still
 * grow into a credential (for example `gh` or `Bearer `). That piece is held until it is complete, so a credential
 * split across chunks is still seen whole.
 */

const REDACTED = "<redacted>";

/** A held piece longer than this is released anyway, so memory stays bounded. */
const MAX_PENDING_CHARS = 16 * 1024;

// Left boundary: not inside a longer token. A preceding SGR color sequence such as `\x1b[31m` also counts as a
// boundary, although it ends in a letter.
const B = "(?:(?<![A-Za-z0-9_-])|(?<=\\x1b\\[[0-9;]*m))";
// Right boundary: the token ends here.
const E = "(?![A-Za-z0-9_-])";

interface CredentialPattern {
	regex: RegExp;
	/** Literal substrings, one of which every match contains. Text containing none skips the regex. */
	literals: readonly string[];
}

const pattern = (source: string, literals: readonly string[], flags = ""): CredentialPattern => ({
	regex: new RegExp(source, `g${flags}`),
	literals,
});

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
	// OpenAI and Anthropic keys. The digit lookahead keeps long hyphenated names like `sk-learn-...` readable.
	pattern(`${B}sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}${E}`, ["sk-"]),
	pattern(`${B}gh[opusr]_[A-Za-z0-9]{30,}${E}`, ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]),
	pattern(`${B}github_pat_[A-Za-z0-9_]{22,}${E}`, ["github_pat_"]),
	pattern(`${B}glpat-[A-Za-z0-9_-]{20,}${E}`, ["glpat-"]),
	pattern(`${B}xox[abprs]-[A-Za-z0-9-]{10,}${E}`, ["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"]),
	pattern(`${B}(?:AKIA|ASIA)[A-Z0-9]{16}${E}`, ["AKIA", "ASIA"]),
	pattern(`${B}AIza[A-Za-z0-9_-]{35}${E}`, ["AIza"]),
	pattern(`${B}npm_[A-Za-z0-9]{36}${E}`, ["npm_"]),
	pattern(`${B}hf_[A-Za-z0-9]{30,}${E}`, ["hf_"]),
	pattern(`${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}${E}`, ["sk_live_", "sk_test_", "rk_live_", "rk_test_"]),
	pattern(`${B}whsec_[A-Za-z0-9]{20,}${E}`, ["whsec_"]),
	pattern(`${B}SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}${E}`, ["SG."]),
	pattern(`${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}${E}`, ["eyJ"]),
	pattern(`(?<=\\bBearer\\s+)[A-Za-z0-9._~+/=-]{20,}${E}`, ["bearer"], "i"),
	// The password of `scheme://user:password@host`; the user name stays visible.
	pattern(`(?<=[A-Za-z][A-Za-z0-9+.-]*://[^\\s/:@]*:)[^\\s/@]+(?=@)`, ["://"]),
];

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** Replaces every credential shape in `text` with `<redacted>`. PEM blocks span lines and are handled by the redactor. */
function redactCredentials(text: string): string {
	const lower = text.toLowerCase();
	let result = text;
	for (const { regex, literals } of CREDENTIAL_PATTERNS) {
		const caseInsensitive = regex.flags.includes("i");
		if (!literals.some((literal) => (caseInsensitive ? lower : text).includes(literal))) continue;
		result = result.replace(regex, REDACTED);
	}
	return result;
}

/** Lowercase literals that start a credential: a trailing piece containing or starting one of them is held. */
const HOLD_LITERALS = [
	...new Set([...CREDENTIAL_PATTERNS.flatMap(({ literals }) => literals), "-----begin"].map((l) => l.toLowerCase())),
];
const TOKEN_CHAR = /[a-z0-9_-]/;
const SGR_END = /\x1b\[[0-9;]*m$/;
const BEARER_INTRODUCER = /\bbearer\s+$/i;

/** Returns where the held piece of an unterminated line starts; `line.length` when nothing needs holding. */
function holdStart(line: string): number {
	let start = line.length;
	// A PEM header has spaces, so hold from its start until the header is complete.
	const begin = line.indexOf("-----BEGIN");
	if (begin !== -1 && !PRIVATE_KEY_BEGIN.test(line.slice(begin))) start = begin;
	const runStart = Math.max(line.lastIndexOf(" "), line.lastIndexOf("\t")) + 1;
	const bearer = BEARER_INTRODUCER.exec(line.slice(0, runStart));
	if (bearer) return Math.min(start, bearer.index);
	const run = line.slice(runStart).toLowerCase();
	if (run && mayStartCredential(run)) return Math.min(start, runStart);
	return start;
}

/** Whether `run`, the last whitespace-free piece of output, contains a credential literal or ends with the start of one. */
function mayStartCredential(run: string): boolean {
	for (const literal of HOLD_LITERALS) {
		if (run.includes(literal)) return true;
		for (let length = Math.min(literal.length - 1, run.length); length >= 1; length--) {
			const at = run.length - length;
			if (!run.endsWith(literal.slice(0, length))) continue;
			// A partial literal counts only where a credential can begin, not inside a word such as `progress`.
			const before = run.slice(0, at);
			if (!TOKEN_CHAR.test(literal[0]) || at === 0 || !TOKEN_CHAR.test(before.at(-1)!) || SGR_END.test(before)) {
				return true;
			}
		}
	}
	return false;
}

/** One redactor per output stream: `push()` returns the text that is safe to release, `finish()` the rest. */
export class SecretOutputRedactor {
	private pending = "";
	private inPrivateKey = false;

	push(text: string): string {
		this.pending += text;
		// Complete lines first: they decide whether the unterminated rest is inside a private key.
		const lineStart = Math.max(this.pending.lastIndexOf("\n"), this.pending.lastIndexOf("\r")) + 1;
		const lines = this.release(lineStart);
		return lines + this.release(this.releasableLength());
	}

	finish(): string {
		return this.release(this.pending.length);
	}

	/** How much of the unterminated line in `pending` can be released now. */
	private releasableLength(): number {
		// Inside a private key the line is suppressed anyway; holding it keeps a split END marker whole.
		const start = this.inPrivateKey ? 0 : holdStart(this.pending);
		return this.pending.length - start > MAX_PENDING_CHARS ? this.pending.length : start;
	}

	private release(end: number): string {
		const text = this.pending.slice(0, end);
		this.pending = this.pending.slice(end);
		let output = "";
		for (const line of text.split(/(?<=[\r\n])/)) output += this.redactLine(line);
		return output;
	}

	private redactLine(line: string): string {
		if (this.inPrivateKey) {
			const end = PRIVATE_KEY_END.exec(line);
			if (!end) return "";
			this.inPrivateKey = false;
			return this.redactLine(line.slice(end.index + end[0].length));
		}
		const begin = PRIVATE_KEY_BEGIN.exec(line);
		if (!begin) return redactCredentials(line);
		this.inPrivateKey = true;
		const before = redactCredentials(line.slice(0, begin.index));
		return before + REDACTED + this.redactLine(line.slice(begin.index + begin[0].length));
	}
}
