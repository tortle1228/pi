// Verify the EXAONE footer status from rate-limit headers, using a fixture with only the host methods the extension uses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import exaoneLimits, { formatExaoneLimits } from "../src/extensions/exaone-limits/index.ts";

// Headers from a live k-exaone_v2.5 response.
const LIVE_HEADERS = {
	"x-day-rate-limit": "100",
	"x-day-rate-limit-remaining": "70",
	"x-minute-rate-limit": "60",
	"x-minute-rate-limit-remaining": "59",
	"x-second-rate-limit": "1",
	"x-second-rate-limit-remaining": "0",
};

function setup() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const statuses = new Map<string, string>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
	};
	exaoneLimits(pi as unknown as ExtensionAPI);
	const ctx = {
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}` },
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
	} as unknown as ExtensionContext;
	const emit = (event: string, payload: object) => handlers.get(event)?.({ type: event, ...payload }, ctx);
	return { statuses, emit };
}

describe("exaone limits", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 2, 9, 5));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("formats day and minute windows and skips the second window", () => {
		expect(formatExaoneLimits(LIVE_HEADERS)).toEqual({ text: "EXAONE day 70/100 · min 59/60 @09:05", low: false });
	});

	it("flags a low daily remainder and tolerates a missing limit", () => {
		expect(formatExaoneLimits({ "x-day-rate-limit": "100", "x-day-rate-limit-remaining": "20" })?.low).toBe(true);
		expect(formatExaoneLimits({ "x-day-rate-limit-remaining": "5" })).toEqual({
			text: "EXAONE day 5 @09:05",
			low: false,
		});
		expect(formatExaoneLimits({ "x-request-id": "x" })).toBeUndefined();
	});

	it("updates only for EXAONE responses and clears on switching away", () => {
		const { statuses, emit } = setup();
		emit("after_provider_response", { provider: "openai", model: "gpt", status: 200, headers: LIVE_HEADERS });
		expect(statuses.size).toBe(0);

		emit("after_provider_response", {
			provider: "exaone",
			model: "k-exaone_v2.5",
			status: 200,
			headers: LIVE_HEADERS,
		});
		expect(statuses.get("exaone-limits")).toBe("<dim>EXAONE day 70/100 · min 59/60 @09:05");

		// A response without the headers keeps the last values.
		emit("after_provider_response", { provider: "exaone", model: "k-exaone_v2.5", status: 200, headers: {} });
		expect(statuses.get("exaone-limits")).toBe("<dim>EXAONE day 70/100 · min 59/60 @09:05");

		emit("model_select", { model: { provider: "exaone" } });
		expect(statuses.has("exaone-limits")).toBe(true);
		emit("model_select", { model: { provider: "openai" } });
		expect(statuses.has("exaone-limits")).toBe(false);
	});
});
