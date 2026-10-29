/**
 * The `edit` tool in hashline mode (`editMode: "hashline"`): edits address lines by the tags `read` and `grep` show,
 * such as `12#kq`, instead of repeating their text. See `hashline.ts`.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { defaultEditOperations, type EditToolDetails, type EditToolOptions } from "./edit.ts";
import {
	detectLineEnding,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { applyHashlineEdits } from "./hashline.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const hashlineEditSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(
		Type.Object({
			start: Type.String({
				description: 'Tag of the first line to replace, or of the line to insert next to, such as "12#kq"',
			}),
			end: Type.Optional(
				Type.String({ description: "Tag of the last line to replace (inclusive). Default: start" }),
			),
			insert: Type.Optional(
				StringEnum(["before", "after"] as const, {
					description: "Insert newText before or after the start line instead of replacing lines",
				}),
			),
			newText: Type.String({ description: "The new lines, without tags. Empty deletes the lines." }),
		}),
		{ description: "One or more edits. All tags refer to the file as last read, not to earlier edits in this call." },
	),
});

export type HashlineEditToolInput = Static<typeof hashlineEditSchema>;

export const hashlineEditToolSystemPromptContribution = {
	snippet: "Edit files by the line tags that read and grep show, including multiple edits in one call",
	guidelines: [
		"Use edit with the line tags (such as 12#kq) that read and grep show before each line. newText holds only the new lines, without tags.",
		"To replace one line set start; for a range set start and end; to add lines set insert to before or after.",
		"All edits in one call use tags from the same read. After an edit, use the tags in its result for the next edit.",
	],
} as const;

export function createHashlineEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof hashlineEditSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file by line tags. read and grep show each line as TAG|text, where TAG is the line number and a hash of the line, such as 12#kq. Address lines by their tags; an edit whose tags no longer match the file is rejected and shows the current lines.",
		promptSnippet: hashlineEditToolSystemPromptContribution.snippet,
		promptGuidelines: [...hashlineEditToolSystemPromptContribution.guidelines],
		parameters: hashlineEditSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments: prepareHashlineEditArguments,
		async execute(
			_toolCallId,
			input: HashlineEditToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			if (!Array.isArray(input.edits) || input.edits.length === 0) {
				throw new Error("Edit tool input is invalid. edits must contain at least one edit.");
			}
			const path = input.path;
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			return withFileMutationQueue(absolutePath, async () => {
				// As in the replace edit: check the signal after each await instead of rejecting from a listener, so the
				// queue stays locked until the current filesystem operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};
				throwIfAborted();
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();
				const { bom, text } = splitBom((await ops.readFile(absolutePath)).toString("utf-8"));
				throwIfAborted();
				const originalEnding = detectLineEnding(text);
				const baseContent = normalizeToLF(text);
				const result = applyHashlineEdits(baseContent, input.edits);
				await ops.writeFile(absolutePath, bom + restoreLineEndings(result.content, originalEnding));
				throwIfAborted();
				const diff = generateDiffString(baseContent, result.content);
				return {
					content: [{ type: "text", text: `Edited ${path}:\n${result.changedLines}` }],
					details: {
						diff: diff.diff,
						patch: generateUnifiedPatch(path, baseContent, result.content),
						firstChangedLine: diff.firstChangedLine,
					},
				};
			});
		},
		...editRenderers,
	};
}

export function createHashlineEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof hashlineEditSchema> {
	return wrapToolDefinition(createHashlineEditToolDefinition(cwd, options));
}

/** Some models send edits as a JSON string or a single object; accept both, as the replace edit does. */
function prepareHashlineEditArguments(input: unknown): HashlineEditToolInput {
	if (!input || typeof input !== "object") return input as HashlineEditToolInput;
	const args = input as Record<string, unknown>;
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			args.edits = Array.isArray(parsed) ? parsed : [parsed];
		} catch {}
	} else if (args.edits && typeof args.edits === "object" && !Array.isArray(args.edits)) {
		args.edits = [args.edits];
	}
	return args as HashlineEditToolInput;
}
