// Shared HTTP plumbing for keyed search backends: deadline, key redaction, and JSON POST.

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Run `run` under a deadline and the caller's signal. Errors are rewritten so the key never leaks. */
export async function withDeadline<T>(
	service: string,
	label: string,
	ms: number,
	signal: AbortSignal | undefined,
	apiKey: string,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (signal?.aborted) throw new Error(`${service} ${label} cancelled.`);
	const deadline = AbortSignal.timeout(ms);
	const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	try {
		return await run(requestSignal);
	} catch (error) {
		if (signal?.aborted) throw new Error(`${service} ${label} cancelled.`);
		if (deadline.aborted) throw new Error(`${service} ${label} timed out after ${ms / 1000} seconds.`);
		const message = error instanceof Error ? error.message : String(error);
		const redacted = apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message;
		throw new Error(redacted.trim() || `${service} request failed`);
	}
}

/** POST JSON and parse the reply. `errorText` pulls a message out of a failed JSON body. */
export async function postJson(
	service: string,
	url: string,
	body: unknown,
	headers: Record<string, string>,
	signal: AbortSignal,
	label: string,
	errorText: (payload: unknown) => string | undefined,
): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
		redirect: "error",
	});
	if (!response.ok) {
		let message = response.statusText || "request failed";
		try {
			message = errorText(await response.json()) ?? message;
		} catch {
			/* A non-JSON error body still reports the status. */
		}
		throw new Error(`${service} ${label} request failed (${response.status}): ${message}`);
	}
	try {
		return await response.json();
	} catch {
		throw new Error(`${service} returned malformed ${label.toLowerCase()} JSON.`);
	}
}
