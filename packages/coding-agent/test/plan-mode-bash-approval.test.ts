import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import planMode from "../src/extensions/plan-mode/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

function setup(settings: Settings, mode: "plan" | "build" = "plan") {
	const handlers = new Map<string, Handler>();
	const api = {
		registerFlag: vi.fn(),
		registerMarkdownTransformer: vi.fn(),
		registerCommand: vi.fn(),
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getFlag: () => "",
		getMode: () => mode,
		getSettings: () => settings,
		getActiveTools: () => ["read", "bash"],
		getAllTools: () => [],
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI;
	planMode(api);
	const select = vi.fn(async () => "Deny");
	const ctx = {
		mode: "tui",
		ui: { select },
		sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
	} as unknown as ExtensionContext;
	// The setting is read when the user prompt starts.
	const start = () =>
		handlers.get("before_agent_start")?.({}, ctx) as Promise<{ message: { content: string } } | undefined>;
	const callBash = async (command: string) => {
		await start();
		return handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command } },
			ctx,
		);
	};
	return { callBash, start, select };
}

describe("Plan mode bash approval setting", () => {
	it.each(["ask", "allow"] as const)("blocks mutations without approval under %s", async (bashApproval) => {
		const { callBash, select } = setup({ plan: { bashApproval } });
		for (const command of [
			"rm file",
			"git status && git commit -m x",
			"echo x > file",
			"npm install foo",
			"curl -X POST https://example.com",
			"kubectl delete pod example",
			"kubectl --context=prod delete deployment app",
			"terraform -chdir=infra apply",
			"npm --prefix /tmp/project install foo",
			"curl -A -- -X POST https://example.com",
		]) {
			expect(await callBash(command)).toMatchObject({ block: true, reason: expect.stringContaining("Build mode") });
		}
		expect(select).not.toHaveBeenCalled();
	});

	it("does not block option values that resemble mutations", async () => {
		const { callBash, select } = setup({ plan: { bashApproval: "allow" } });
		for (const command of ["find . -name '-delete'", "sort -to input.txt", "kubectl --context delete get pods"]) {
			expect(await callBash(command)).toBeUndefined();
		}
		expect(select).not.toHaveBeenCalled();
	});

	it("does not restrict Build mode", async () => {
		const { callBash, select } = setup({}, "build");
		expect(await callBash("rm file")).toBeUndefined();
		expect(select).not.toHaveBeenCalled();
	});

	it("asks for unknown commands by default", async () => {
		const { callBash, select } = setup({});
		expect(await callBash("npm test")).toMatchObject({ block: true });
		expect(select).toHaveBeenCalledWith(expect.any(String), ["Allow", "Deny"]);
	});

	it("runs unknown commands without asking when set to allow", async () => {
		const { callBash, start, select } = setup({ plan: { bashApproval: "allow" } });
		expect(await callBash("npm test")).toBeUndefined();
		expect(select).not.toHaveBeenCalled();
		expect((await start())?.message.content).toContain("without asking the user");
	});
});
