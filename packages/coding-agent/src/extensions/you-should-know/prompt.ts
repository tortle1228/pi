export type OfferTag = "Heads up" | "You should know";

export type Observation =
	| { kind: "none" }
	| { kind: "invalid" }
	| { kind: "offer"; line: string; tag: OfferTag; explanation: string };

export function observerPrompt(seen: readonly string[]): string {
	const shown =
		seen.length === 0
			? ""
			: `\nAlready shown to the user. Do not repeat these or close variants:\n${seen.map((line) => `- ${line}`).join("\n")}\n`;
	return `<system-reminder>
This is a side request from pi's "You should know" feature, not from the user. Do not call tools. Answer in this single response.

You are an observer watching this session on the user's behalf while the main agent keeps working. Decide whether there is one thing the user should really know right now and very likely does not.

Pick at most one topic. It must clear every bar:
- Consequential: missing it costs money, time, wasted work or a wrong result, or it affects a decision in progress. "Interesting" is not enough.
- Not covered: the main agent has not explained it and probably will not. Skip anything the user already showed they understand.
- Grounded: you are confident it is true from this session. If part of it is uncertain, say so in the explanation.
- Not trivia: file layout, naming or registration details do not qualify.

Tags:
- Heads up: about this session's work: a decision the agent made, something it did not highlight, or a result that may be off, with an immediate cost if missed.
- You should know: a system, concept or design the user should understand because it matters for their work.

Write for a tired user switching back from another task: plain words, name the actual thing (never "this" or "it"), at most two clauses in the learn line, no questions. Do not overstate: if it may be true, say "may". Use only URLs that appeared in the session.

When in doubt, output exactly:
learn: none

Otherwise output exactly this shape:
learn: <one short sentence>
tag: <Heads up or You should know>
explain:
**<short title>**
* <3 to 5 short bullets a newcomer can follow, ending with what to check or do>

Write the learn line, title and bullets in the language the user writes in. Keep the labels learn:, tag:, explain:, the word none and the tag names in English.
${shown}</system-reminder>`;
}

const LABEL = /^[\s>*_`"']*(learn|tag|explain)[\s*_`"']*:[*_]*\s*(.*)$/i;

export function parseObservation(text: string): Observation {
	let line = "";
	let tag: OfferTag = "You should know";
	let explaining = false;
	const explanation: string[] = [];
	for (const raw of text.split("\n")) {
		if (explaining) {
			explanation.push(raw);
			continue;
		}
		const match = LABEL.exec(raw);
		if (!match) continue;
		const label = match[1].toLowerCase();
		const value = match[2].trim();
		if (label === "learn") {
			if (/^none\b/i.test(value)) return { kind: "none" };
			line = value;
		} else if (label === "tag") {
			tag = /heads[\s-]*up/i.test(value) ? "Heads up" : "You should know";
		} else {
			explaining = true;
			if (value) explanation.push(value);
		}
	}
	if (!line) return { kind: "invalid" };
	return { kind: "offer", line, tag, explanation: explanation.join("\n").trim() };
}

/** Checks to skip after `ignored` offers in a row: none for the first two, then 1, 2, 4, ... up to 16. */
export function skipsAfterIgnores(ignored: number): number {
	return ignored <= 2 ? 0 : Math.min(16, 2 ** (ignored - 3));
}

export function normalizeLine(line: string): string {
	return line.trim().toLowerCase().replace(/\.+$/, "");
}
