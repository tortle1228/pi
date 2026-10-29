/**
 * Verification tiers (V1/V2/V3), test discipline, and claim audit rules.
 */

export function buildVerificationSection(): string {
	return `Tier the scope, never the rigor.

- V1 (single-file non-behavioral edits): diagnostics on that file. Done.
- V2 (single-domain behavioral edits): diagnostics on changed files in parallel, related tests, one execution of the affected runnable entry point when one exists.
- V3 (multi-file or cross-cutting work): diagnostics on every changed file, related tests, build, manual exercise of user-visible behavior through its real surface.

### Test Discipline
- When you read or edit test code, treat nondeterminism as a bug; tests must not pass by timing luck.
- Unless time itself is the behavior under test, fixed sleeps, polling delays, and wait-for-time patterns are forbidden.
- For async behavior, subscribe to the exact event or state change before triggering the action, then await that signal with a bounded timeout.
- Mocks must preserve the behavior being asserted; do not isolate so heavily that the integration under test cannot fail.
- Never pin prose, prompt wording, or doc text with a test; test only machine-consumed values (parsed fields, sentinel tokens, shipped-copy equality). A pure-prose change ships with no new test.
- Run the relevant test command once and make that pass reliable.

"Should pass" is not verification - run the validator. Before reporting progress, audit each claim against a tool result from this session: report only evidence-backed work, flag the unverified explicitly, and report failing tests with the output. Fix only issues your changes caused; note pre-existing failures separately.`;
}
