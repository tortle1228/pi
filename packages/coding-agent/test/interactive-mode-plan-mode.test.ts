import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function createContext(options: { hasPlanExtension: boolean; isStreaming?: boolean; mode?: "build" | "plan" }) {
	return {
		session: {
			extensionRunner: { getCommand: () => (options.hasPlanExtension ? { name: "plan" } : undefined) },
			isStreaming: options.isStreaming ?? false,
			getMode: () => options.mode ?? "build",
			setMode: vi.fn(async () => {}),
		},
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
}

const prototype = InteractiveMode.prototype as unknown as {
	cycleMode(this: ReturnType<typeof createContext>): void;
};

describe("InteractiveMode mode cycling", () => {
	it("switches between build and plan", () => {
		const build = createContext({ hasPlanExtension: true });
		prototype.cycleMode.call(build);
		expect(build.session.setMode).toHaveBeenCalledWith("plan");

		const plan = createContext({ hasPlanExtension: true, mode: "plan" });
		prototype.cycleMode.call(plan);
		expect(plan.session.setMode).toHaveBeenCalledWith("build");
	});

	it("refuses Plan mode when the extension enforcing it is not loaded", () => {
		const context = createContext({ hasPlanExtension: false });
		prototype.cycleMode.call(context);
		expect(context.session.setMode).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Plan mode needs the built-in plan-mode extension");
	});

	it("refuses to switch during a run", () => {
		const context = createContext({ hasPlanExtension: true, isStreaming: true });
		prototype.cycleMode.call(context);
		expect(context.session.setMode).not.toHaveBeenCalled();
	});
});
