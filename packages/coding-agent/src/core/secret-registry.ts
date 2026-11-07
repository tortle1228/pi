/**
 * Secret values pi itself holds — provider API keys, OAuth tokens, configured search or MCP keys — registered so the
 * output redactor can mask them by exact match, including formats no credential shape covers (Exa UUIDs, `tvly-` keys).
 */

/** Values shorter than this are not registered: masking them would over-redact ordinary text. */
const MIN_LENGTH = 16;
/** Whole words of a configured name that mark its value as a secret; `GIT_AUTHOR_EMAIL` has no such word. */
const SECRET_NAME_RE = /(?:^|[_-])(?:api_?key|key|token|secret|password|credentials?|auth|authorization)(?:$|[_-])/i;
/** An `Authorization` scheme: the token behind it is the secret, and output can show it without the scheme. */
const AUTH_SCHEME_RE = /^(?:Bearer|Basic|Token)\s+/i;

const known = new Set<string>();

/** Registers a value pi holds that must not appear in tool output. Newlines exclude it: output is redacted per line. */
export function registerKnownSecret(value: string | undefined): void {
	if (value && value.length >= MIN_LENGTH && !value.includes("\n")) known.add(value);
}

/**
 * Registers a configured value that may still be a `$VAR`, `${VAR}` template, or `!command` reference; a reference is
 * not the secret itself, and resolving it here would run commands at load time, so it is skipped.
 */
export function registerConfiguredSecret(spec: string | undefined): void {
	if (spec && !spec.startsWith("$") && !spec.startsWith("!") && !spec.includes("${")) registerKnownSecret(spec);
}

/** Whether a configured name such as `GITHUB_TOKEN`, `authToken` or `X-Api-Key` says its value is a secret. */
export function isSecretName(name: string): boolean {
	return SECRET_NAME_RE.test(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

/** Registers a resolved header or env value whose name says it is a secret. */
export function registerNamedSecret(name: string, value: string | undefined): void {
	if (isSecretName(name)) registerKnownSecret(value?.replace(AUTH_SCHEME_RE, ""));
}

/** The registered values, for the output redactor. */
export function knownSecrets(): readonly string[] {
	return [...known];
}

/** Length of the longest suffix of `text` that could still grow into a registered secret. */
export function partialSecretSuffixLength(text: string): number {
	let longest = 0;
	for (const secret of known) {
		for (let length = Math.min(secret.length - 1, text.length); length > longest; length--) {
			if (text.endsWith(secret.slice(0, length))) {
				longest = length;
				break;
			}
		}
	}
	return longest;
}
