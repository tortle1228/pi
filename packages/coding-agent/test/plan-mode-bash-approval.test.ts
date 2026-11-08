import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import planMode from "../src/extensions/plan-mode/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

function setup(settings: Settings) {
	const handlers = new Map<string, Handler>();
	const api = {
		registerFlag: vi.fn(),
		registerMarkdownTransformer: vi.fn(),
		registerCommand: vi.fn(),
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getFlag: () => "",
		getMode: () => "plan",
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
