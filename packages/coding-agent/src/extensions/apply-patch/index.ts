/**
 * The `apply_patch` tool as an extension: Codex-format patches (`*** Begin Patch` ... `*** End Patch`) that add,
 * delete, update, or move files. The CLI loads it as a built-in extension; SDK users add `createApplyPatchExtension()`
 * to their extension factories, or `createApplyPatchTool()` to their tools.
 *
 * `apply_patch` is registered inactive. Enable it in place of `edit` and `write` with
 * `"defaultTools": ["+apply_patch", "-edit", "-write"]`. Ported from senpi; see NOTICE.md.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createApplyPatchTool } from "./tool.ts";

export { createApplyPatchTool } from "./tool.ts";

export function createApplyPatchExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({ ...createApplyPatchTool(), defaultActive: false });
	};
}

export default createApplyPatchExtension();
