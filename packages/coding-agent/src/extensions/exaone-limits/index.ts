// Shows the remaining EXAONE request limits in the footer, read from the rate-limit headers of each EXAONE response.
// https://docs.exaone.ai/ko/docs/rate-limits
import type { ExtensionAPI } from "../../core/extensions/types.ts";

const STATUS_KEY = "exaone-limits";
// The per-second window (1 request) is always exhausted right after a response, so it is not shown.
const WINDOWS = [
	["day", "day"],
	["minute", "min"],
] as const;
const LOW_DAY_FRACTION = 0.2;

export interface ExaoneLimitsStatus {
	text: string;
	low: boolean;
}

/**
 * Formats the day and minute windows, or returns undefined when the headers carry neither.
 * The receive time is shown because the values stay until the next EXAONE response, possibly past the daily reset.
 */
export function formatExaoneLimits(headers: Record<string, string>, now = new Date()): ExaoneLimitsStatus | undefined {
	const parts: string[] = [];
	let low = false;
	for (const [window, label] of WINDOWS) {
		const remaining = Number.parseInt(headers[`x-${window}-rate-limit-remaining`] ?? "", 10);
		if (!Number.isFinite(remaining)) continue;
		const limit = Number.parseInt(headers[`x-${window}-rate-limit`] ?? "", 10);
		const hasLimit = Number.isFinite(limit) && limit > 0;
		parts.push(hasLimit ? `${label} ${remaining}/${limit}` : `${label} ${remaining}`);
		if (window === "day" && hasLimit && remaining <= limit * LOW_DAY_FRACTION) low = true;
	}
	if (parts.length === 0) return undefined;
	const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	return { text: `EXAONE ${parts.join(" · ")} @${time}`, low };
}

export default function exaoneLimitsExtension(pi: ExtensionAPI): void {
	pi.on("after_provider_response", (event, ctx) => {
		if (event.provider !== "exaone") return;
		// Error responses (429) do not reach this event, so the last known values stay until the next success.
		const status = formatExaoneLimits(event.headers);
		if (!status) return;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(status.low ? "warning" : "dim", status.text), { align: "right" });
	});

	pi.on("model_select", (event, ctx) => {
		if (event.model.provider !== "exaone") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
