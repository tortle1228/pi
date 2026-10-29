/**
 * Standard progress and completion reporting block (handoff).
 */

const HANDOFF_LANGUAGE_RULE =
	"Write the handoff block and all progress updates in the user's language. In Korean, use natural labels like '요청:', '진행 상황:', '현재 작업:', '다음 단계:' (or integrate naturally into the response). In English, use 'Ask:', 'wanted:', 'For you:', 'Now:', 'Next:'. Never leak English labels into Korean responses.";

export function buildHandoffSection(): string {
	return `A handoff is the start of a multi-step task, a major plan change, a blocker, or the end of a turn that changed something; the routing line is not one, and an answer stays an answer, even after tool calls. Before writing one, weigh what the user originally asked for and what they would want to know right now; then state it in one short block:

- Korean: 요청: [사용자 요청] - 목표: [원하는 결과]. 진행 상황: [현재 상황/결과]. 현재 작업: [진행 중인 작업]. 다음 단계: [다음 할 일].
- English: Ask: [user's request] - wanted: [outcome]. For you: [findings, blockers, status]. Now: [in progress]. Next: [next open task].

${HANDOFF_LANGUAGE_RULE} The next task you name is executed in this same response with tool calls; declaring a next task with nothing after it is a defect. Between handoffs, work without narration.`;
}
