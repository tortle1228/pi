/**
 * Ends the `task` tool's `output` waits when the user types during a run, so the model reads the message instead of
 * holding the turn until the task ends.
 */

/** The open waits of one extension instance, and whether user input is waiting to reach the conversation. */
export class WaitStop {
	private readonly open = new Set<AbortController>();
	/**
	 * Set from the user's input until the message enters the conversation. Input can arrive after a waiting tool
	 * started but before its wait opened, since the tool-start event comes before the tool runs.
	 */
	private pending = false;

	/** The user typed during the run: end every open wait, and every wait that opens before the message is read. */
	userInput(): void {
		this.pending = true;
		for (const controller of this.open) controller.abort();
	}

	/** The user's message entered the conversation, or the run ended. */
	clear(): void {
		this.pending = false;
	}

	/** Runs `wait` with a signal that also aborts on user input; `stopped` tells whether user input ended it. */
	async run<T>(
		signal: AbortSignal | undefined,
		wait: (signal: AbortSignal) => Promise<T>,
	): Promise<{ value: T; stopped: boolean }> {
		const controller = new AbortController();
		if (this.pending) controller.abort();
		this.open.add(controller);
		try {
			const value = await wait(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
			return { value, stopped: controller.signal.aborted };
		} finally {
			this.open.delete(controller);
		}
	}
}
