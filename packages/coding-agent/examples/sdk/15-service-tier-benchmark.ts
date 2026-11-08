/**
 * Fast / ultrafast service tier benchmark
 *
 * Sends the same prompt through real pi sessions with fastMode off, fast and ultrafast and
 * compares the tier pi sent, the tier the server reported, latency, throughput and cost.
 * THIS SPENDS REAL MONEY (and Codex plan usage). Runs stop once --budget is reached.
 *
 * Usage (from packages/coding-agent, after `npm run build`):
 *   node examples/sdk/15-service-tier-benchmark.ts --runs 10 --budget 20
 *
 * Options (comma-separated lists):
 *   --providers openai,openai-codex   --models gpt-6.1-sol,gpt-6-astra   --modes off,fast,ultrafast
 *   --runs 10 (per cell, after one discarded warmup)   --budget 20 (USD)   --out /tmp/pi-tier-bench.jsonl
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

type Mode = "off" | "fast" | "ultrafast";

const { values } = parseArgs({
	options: {
		providers: { type: "string", default: "openai,openai-codex" },
		models: { type: "string", default: "gpt-6.1-sol,gpt-6-astra" },
		modes: { type: "string", default: "off,fast,ultrafast" },
		runs: { type: "string", default: "10" },
		budget: { type: "string", default: "20" },
		out: { type: "string", default: "/tmp/pi-tier-bench.jsonl" },
	},
});
const providers = values.providers.split(",");
const modelIds = values.models.split(",");
const modes = values.modes.split(",") as Mode[];
const runs = Number(values.runs);
const budget = Number(values.budget);

interface Result {
	provider: string;
	model: string;
	mode: Mode;
	warmup: boolean;
	sentTier: string | null;
	reportedTier: string | null;
	status: number | null;
	requestId: string | null;
	ttftMs: number | null;
	totalMs: number;
	outputTokens: number;
	tokPerSec: number | null;
	cost: number;
	error: string | null;
}

const modelRuntime = await ModelRuntime.create();
const cwd = process.cwd();
const agentDir = getAgentDir();

async function runOnce(provider: string, modelId: string, mode: Mode, warmup: boolean): Promise<Result> {
	const model = modelRuntime.getModel(provider, modelId);
	if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);

	const observed: { sent: string | null; reported: string | null; status: number | null; requestId: string | null } = {
		sent: null,
		reported: null,
		status: null,
		requestId: null,
	};
	// In-memory settings: the benchmark never touches the user's saved fastMode.
	const settingsManager = SettingsManager.inMemory({ fastMode: mode, transport: "sse" });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPromptOverride: () => "You are a concise technical writer.",
		appendSystemPromptOverride: () => [],
		extensionFactories: [
			(pi) => {
				pi.on("before_provider_request", (event) => {
					const payload = event.payload as { service_tier?: string };
					observed.sent = payload.service_tier ?? null;
				});
				pi.on("after_provider_response", (event) => {
					observed.status = event.status;
					observed.requestId = event.headers["x-request-id"] ?? null;
				});
				pi.on("provider_stream_event", (event) => {
					const data = event.data as { type?: string; response?: { service_tier?: string } };
					if (data.type === "response.completed" || data.type === "response.incomplete") {
						observed.reported = data.response?.service_tier ?? null;
					}
				});
			},
		],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		model,
		thinkingLevel: "low",
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		noTools: "all",
	});

	const start = Date.now();
	let firstTextAt: number | null = null;
	let outputTokens = 0;
	let cost = 0;
	let error: string | null = null;
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			firstTextAt ??= Date.now();
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			outputTokens = event.message.usage.output;
			cost = event.message.usage.cost.total;
			if (event.message.stopReason === "error") error = event.message.errorMessage ?? "unknown error";
		}
	});

	try {
		// The nonce prevents prompt-cache hits from skewing latency and cost between runs.
		const nonce = Math.random().toString(36).slice(2);
		await session.prompt(`[${nonce}] Explain in about 400 words how TCP congestion control works.`);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	} finally {
		session.dispose();
	}

	const totalMs = Date.now() - start;
	const generationMs = firstTextAt === null ? null : Date.now() - firstTextAt;
	return {
		provider,
		model: modelId,
		mode,
		warmup,
		sentTier: observed.sent,
		reportedTier: observed.reported,
		status: observed.status,
		requestId: observed.requestId,
		ttftMs: firstTextAt === null ? null : firstTextAt - start,
		totalMs,
		outputTokens,
		tokPerSec: generationMs && generationMs > 0 ? outputTokens / (generationMs / 1000) : null,
		cost,
		error,
	};
}

function percentile(xs: number[], p: number): number | null {
	if (xs.length === 0) return null;
	const sorted = [...xs].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const cells = providers.flatMap((provider) =>
	modelIds.flatMap((model) => modes.map((mode) => ({ provider, model, mode }))),
);
const results: Result[] = [];
let spent = 0;
writeFileSync(values.out, "");

async function record(cell: (typeof cells)[number], warmup: boolean): Promise<boolean> {
	if (spent >= budget) return false;
	const result = await runOnce(cell.provider, cell.model, cell.mode, warmup);
	spent += result.cost;
	appendFileSync(values.out, `${JSON.stringify(result)}\n`);
	if (!warmup) results.push(result);
	console.error(
		`${warmup ? "warmup " : ""}${cell.provider}/${cell.model} ${cell.mode}: sent=${result.sentTier} reported=${result.reportedTier} ` +
			`ttft=${result.ttftMs}ms ${result.tokPerSec?.toFixed(0) ?? "-"} tok/s $${result.cost.toFixed(4)} ${result.error ?? ""} (spent $${spent.toFixed(2)})`,
	);
	return true;
}

for (const cell of cells) await record(cell, true);
// Round-robin across cells so time-of-day load affects every cell equally.
let budgetHit = false;
for (let i = 0; i < runs && !budgetHit; i++) {
	for (const cell of cells) {
		if (!(await record(cell, false))) {
			budgetHit = true;
			break;
		}
	}
}

console.log(`\nSpent $${spent.toFixed(2)} of $${budget}${budgetHit ? " (budget reached, run stopped early)" : ""}`);
console.table(
	cells.map((cell) => {
		const rs = results.filter((r) => r.provider === cell.provider && r.model === cell.model && r.mode === cell.mode);
		const ok = rs.filter((r) => !r.error);
		const tiers = new Map<string, number>();
		for (const r of rs) {
			const key = `${r.sentTier ?? "-"}>${r.reportedTier ?? "-"}`;
			tiers.set(key, (tiers.get(key) ?? 0) + 1);
		}
		return {
			cell: `${cell.provider}/${cell.model} ${cell.mode}`,
			n: rs.length,
			errors: rs.length - ok.length,
			"sent>reported": [...tiers].map(([k, n]) => `${k} x${n}`).join(", "),
			"ttft p50 ms": percentile(
				ok.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs])),
				0.5,
			),
			"ttft p90 ms": percentile(
				ok.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs])),
				0.9,
			),
			"tok/s p50": percentile(
				ok.flatMap((r) => (r.tokPerSec === null ? [] : [r.tokPerSec])),
				0.5,
			)?.toFixed(0),
			"avg cost $": ok.length === 0 ? null : (ok.reduce((sum, r) => sum + r.cost, 0) / ok.length).toFixed(4),
		};
	}),
);
