// The request_user_input tool: short multiple-choice questions, available in Plan and Build mode.
import { Container, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { type QuestionAnswer, QuestionView } from "./question-view.ts";

const RequestUserInputParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String({ description: "Stable identifier for mapping answers (snake_case)." }),
			header: Type.String({ description: "Short header label shown in the UI (12 or fewer chars)." }),
			question: Type.String({ description: "Single-sentence prompt shown to the user." }),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "User-facing label (1-5 words)." }),
					description: Type.String({ description: "One short sentence explaining impact/tradeoff if selected." }),
				}),
				{
					minItems: 2,
					description:
						'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
				},
			),
		}),
		{ minItems: 1, maxItems: 3, description: "Questions to show the user. Prefer 1 and do not exceed 3" },
	),
});

interface RequestUserInputDetails {
	total: number;
	answers: QuestionAnswer[];
}

/** The answer payload the model receives. A note travels as an extra `user_note:` entry. */
export function formatAnswers(answers: readonly QuestionAnswer[]): string {
	const byId = Object.fromEntries(
		answers.map(({ id, answer, note }) => [id, { answers: note ? [answer, `user_note: ${note}`] : [answer] }]),
	);
	return JSON.stringify({ answers: byId });
}

function errorResult(message: string, total: number) {
	const details: RequestUserInputDetails = { total, answers: [] };
	return { content: [{ type: "text" as const, text: message }], isError: true, details };
}

export default function requestUserInput(pi: ExtensionAPI): void {
	pi.registerTool<typeof RequestUserInputParams, RequestUserInputDetails>({
		name: "request_user_input",
		label: "Request user input",
		description: "Request user input for one to three short questions and wait for the response.",
		promptSnippet: "Ask the user one to three short multiple-choice questions and wait for the answers",
		parameters: RequestUserInputParams,

		async execute(_toolCallId, params: Static<typeof RequestUserInputParams>, _signal, _onUpdate, ctx) {
			const total = params.questions.length;
			if (ctx.mode !== "tui") return errorResult("request_user_input requires the interactive UI", total);

			const answers = await ctx.ui.custom<QuestionAnswer[] | undefined>(
				(tui, theme, keybindings, done) => new QuestionView(params.questions, tui, theme, keybindings, done),
				{ blocked: { kind: "question", message: params.questions[0].question } },
			);
			if (!answers) {
				ctx.abort();
				return errorResult("Interrupted by the user", total);
			}
			return { content: [{ type: "text", text: formatAnswers(answers) }], details: { total, answers } };
		},

		// The result's first line carries the title once the tool has finished.
		renderCall: (_args, theme, context) =>
			context.isPartial ? new Text(theme.fg("toolTitle", theme.bold("Questions")), 0, 0) : new Container(),

		renderResult(result, options, theme) {
			if (options.isPartial) return new Container();
			const { total, answers } = result.details;
			if (answers.length === 0) {
				return new Text(result.content.find((part) => part.type === "text")?.text ?? "", 0, 0);
			}
			const lines = [`${theme.fg("toolTitle", theme.bold("Questions"))} ${answers.length}/${total} answered`];
			for (const { question, answer, note } of answers) {
				lines.push(`  • ${question}`, `${theme.fg("muted", "    answer: ")}${answer}`);
				if (note) lines.push(`${theme.fg("muted", "    note: ")}${note}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
