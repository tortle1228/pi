/**
 * The `job` tool as an extension. The CLI loads it as a built-in extension; SDK users add `createJobsExtension()` to
 * their extension factories.
 *
 * `job` is registered inactive. Activate it with `--tools`, the `defaultTools` setting (`"+job"`), or
 * `setActiveTools()`. Jobs run with the `shellPath` and `shellCommandPrefix` settings and stop when the session ends. A
 * job that ends on its own is reported with a `job-ended` message.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { type BashOperations, createLocalBashOperations } from "../../core/tools/bash.ts";
import { JobRegistry } from "./job-registry.ts";
import { createJobToolDefinition, formatJobEnded, JOB_ENDED_MESSAGE_TYPE } from "./tool.ts";

export interface JobsExtensionOptions {
	/** Runs the commands. Default: the local shell. */
	operations?: BashOperations;
}

export function createJobsExtension(options: JobsExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		// Settings are readable only once the extension has loaded, so the shell is resolved per job.
		const operations: BashOperations = options.operations ?? {
			exec: (command, cwd, execOptions) =>
				createLocalBashOperations({ shellPath: pi.getSettings().shellPath }).exec(command, cwd, execOptions),
		};
		// A job that ends on its own is reported to the model: before its next call while it runs, or with the next
		// prompt while idle. It never starts a turn by itself.
		const registry = new JobRegistry(operations, (job) =>
			pi.sendMessage(
				{ customType: JOB_ENDED_MESSAGE_TYPE, content: formatJobEnded(job), display: true, details: job },
				{ deliverAs: "steer" },
			),
		);
		pi.registerTool({
			...createJobToolDefinition({ registry, getCommandPrefix: () => pi.getSettings().shellCommandPrefix }),
			defaultActive: false,
		});
		// Reload, new, resume, and fork replace this extension instance, so its jobs would be unreachable.
		pi.on("session_shutdown", () => registry.dispose());
	};
}

export default createJobsExtension();
