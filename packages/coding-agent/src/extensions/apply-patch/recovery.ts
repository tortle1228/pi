import type { ApplyPatchFailure, ApplyPatchRecoveryInstructions, ApplyPatchResult } from "./types.ts";

/**
 * ENOENT (missing file), EACCES/EPERM (permission), ENOTDIR/EISDIR (path) are
 * not context mismatches — rereading will not fix them. Only context-line
 * failures (no error code, thrown by replaceChunks) benefit from a reread.
 */
function isRereadCandidate(failure: ApplyPatchFailure): boolean {
	return failure.code === undefined;
}

export function createRecoveryInstructions(
	result: Pick<ApplyPatchResult, "appliedFiles" | "failures">,
): ApplyPatchRecoveryInstructions {
	const mustReadFiles = [...new Set(result.failures.filter(isRereadCandidate).map((failure) => failure.filePath))];
	const mustReadFileSet = new Set(mustReadFiles);
	const failedFileSet = new Set(result.failures.map((failure) => failure.filePath));
	const mustNotReadFiles = [...new Set(result.appliedFiles.filter((filePath) => !mustReadFileSet.has(filePath)))];
	return { mustReadFiles, mustNotReadFiles, failedFiles: [...failedFileSet] };
}

export function buildPartialFailureText(result: ApplyPatchResult): string {
	const failureLines = result.failures.map(
		(failure) => `- ${failure.filePath} (${failure.operation}): ${failure.message}`,
	);
	const mustReadFiles = result.recoveryInstructions.mustReadFiles;
	const mustReadText = mustReadFiles.join(" and ");
	return [
		result.hasPartialSuccess ? "apply_patch partially failed." : "apply_patch failed.",
		"Failed:",
		...failureLines,
		mustReadFiles.length > 0 ? `Recovery: MUST read ${mustReadText} before retrying.` : "",
		result.appliedFiles.length > 0
			? "Earlier file actions in this patch were already applied."
			: "No file actions were applied.",
		result.recoveryInstructions.mustNotReadFiles.length > 0
			? "Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it."
			: "",
	]
		.filter((line) => line.length > 0)
		.join("\n");
}
