// A side agent that checks the session every few steps and flags one thing the user should know.
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../../core/extensions/types.ts";
import { normalizeLine, observerPrompt, parseObservation, skipsAfterIgnores } from "./prompt.ts";
import { type OfferAction, type OfferView, OfferWidget } from "./widget.ts";

const WIDGET = "you-should-know";
const CHECK_EVERY_TURNS = 6;
const PROMPTS_UNTIL_CLEARED = 2;
const MAX_SEEN = 50;
const ACTIONS: readonly OfferAction[] = ["explain", "chat", "dismiss"];

type Offer = OfferView & { promptsSeen: number };

export default function youShouldKnowExtension(pi: ExtensionAPI) {
	// shortcut: on/off override, seen lines and backoff live in memory only, persist them if restarts lose too much.
	let enabledOverride: boolean | undefined;
	let offer: Offer | undefined;
	let checking: AbortController | undefined;
	let ignoredInARow = 0;
	let skipsLeft = 0;
	let seen: string[] = [];

	const isEnabled = () => enabledOverride ?? pi.getSettings().youShouldKnow ?? false;

	function render(ui: ExtensionUIContext): void {
		const current = offer;
		ui.setWidget(
			WIDGET,
			current ? (_tui, theme) => new OfferWidget(current, theme, (action) => act(action, ui)) : undefined,
		);
	}

	function clear(ui: ExtensionUIContext, ignored: boolean): void {
		offer = undefined;
		if (ignored) {
			ignoredInARow++;
			skipsLeft = skipsAfterIgnores(ignoredInARow);
		}
		render(ui);
	}

	function act(action: OfferAction, ui: ExtensionUIContext): void {
		if (!offer) {
			ui.notify("No You should know note is showing", "info");
			return;
		}
		if (action === "dismiss") {
			clear(ui, true);
			return;
		}
		ignoredInARow = 0;
		skipsLeft = 0;
		if (action === "explain") {
			offer.expanded = true;
			render(ui);
			return;
		}
		if (ui.getEditorText().trim()) {
			ui.notify("Send or clear the prompt box first, then try again", "warning");
			return;
		}
		const details = offer.explanation ? `\n\n${offer.explanation}` : "";
		ui.setEditorText(`Tell me more about this note from the side agent:\n\n${offer.line}${details}`);
		clear(ui, false);
	}

	async function check(ctx: ExtensionContext, model: Model<Api>, messages: Message[]): Promise<void> {
		const controller = new AbortController();
		checking = controller;
		try {
			const thinking = ctx.thinkingLevel;
			// The boundary messages already carry the main system prompt and tools. With the same thinking level and
			// session id, the request starts with the main session's exact prefix and can reuse its prompt cache.
			const stream = ctx.modelRegistry.streamSimple(
				model,
				{
					messages: [
						...messages,
						{ role: "user", content: [{ type: "text", text: observerPrompt(seen) }], timestamp: Date.now() },
					],
				},
				{
					reasoning: thinking === "off" ? undefined : thinking,
					sessionId: ctx.sessionManager.getSessionId(),
					signal: controller.signal,
				},
			);
			const response = await stream.result();
			if (controller.signal.aborted || response.stopReason === "error" || response.stopReason === "aborted") return;
			const text = response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			const result = parseObservation(text);
			if (result.kind !== "offer" || offer) return;
			const key = normalizeLine(result.line);
			if (seen.some((line) => normalizeLine(line) === key)) return;
			seen = [...seen, result.line].slice(-MAX_SEEN);
			offer = {
				line: result.line,
				tag: result.tag,
				explanation: result.explanation,
				expanded: false,
				promptsSeen: 0,
			};
			render(ctx.ui);
		} catch {
			// A failed side check must never disturb the main session.
		} finally {
			if (checking === controller) checking = undefined;
		}
	}

	pi.on("turn_end", (event, ctx) => {
		if ((event.turnIndex + 1) % CHECK_EVERY_TURNS !== 0 || offer || checking || !ctx.hasUI || !ctx.model) return;
		if (!isEnabled()) return;
		if (skipsLeft > 0) {
			skipsLeft--;
			return;
		}
		void check(ctx, ctx.model, event.context.llmMessages);
	});

	pi.on("input", (event, ctx) => {
		if (!offer || event.source === "extension") return;
		offer.promptsSeen++;
		if (offer.promptsSeen >= PROMPTS_UNTIL_CLEARED) clear(ctx.ui, true);
	});

	pi.on("session_shutdown", () => {
		checking?.abort();
		offer = undefined;
		seen = [];
		ignoredInARow = 0;
		skipsLeft = 0;
	});

	pi.registerCommand("you-should-know", {
		description: "Toggle the side agent that flags things you should know; explain, chat or dismiss act on its note",
		getArgumentCompletions: (prefix) =>
			ACTIONS.filter((action) => action.startsWith(prefix)).map((action) => ({ value: action, label: action })),
		handler: async (args, ctx) => {
			const action = args.trim();
			if (!action) {
				enabledOverride = !isEnabled();
				if (!enabledOverride) {
					checking?.abort();
					if (offer) clear(ctx.ui, false);
				}
				ctx.ui.notify(`You should know is ${enabledOverride ? "on" : "off"} for this session`, "info");
				return;
			}
			const known = ACTIONS.find((candidate) => candidate === action);
			if (!known) {
				ctx.ui.notify("Usage: /you-should-know [explain|chat|dismiss]", "error");
				return;
			}
			act(known, ctx.ui);
		},
	});
}
