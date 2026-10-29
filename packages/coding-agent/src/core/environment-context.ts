/**
 * Environment context (working directory + current date) delivered to the
 * model as an append-only, hidden user-role custom message instead of as
 * system prompt text.
 *
 * Ported from senpi (https://github.com/code-yeongyu/senpi, senpi#2093, senpi#2118),
 * adapted to use the local calendar date instead of UTC. The folding in
 * `convertToLlm` (messages.ts) comes from the same source.
 *
 * MIT License
 *
 * Copyright (c) 2026 Yeongyu Kim and senpi contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Carrying the values in a message placed before the next user turn keeps the
 * system prompt byte-stable; a new message is appended only when a value changes.
 *
 * On the wire the message is folded into the leading content block of the user
 * message it precedes, so strict-alternation chat templates (Gemini, Bedrock, etc.)
 * never see two consecutive user messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { CustomMessage } from "./messages.ts";

export const ENVIRONMENT_CONTEXT_MESSAGE_TYPE = "environment-context";

export interface EnvironmentContext {
	/** Working directory with `/` separators. */
	cwd: string;
	/** Local calendar date, `YYYY-MM-DD`. */
	currentDate: string;
}

function formatLocalDate(now: Date): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function resolveEnvironmentContext(cwd: string, now: Date = new Date()): EnvironmentContext {
	return { cwd: cwd.replace(/\\/g, "/"), currentDate: formatLocalDate(now) };
}

export function formatEnvironmentContext(context: EnvironmentContext): string {
	return [
		"<environment_context>",
		`  <cwd>${context.cwd}</cwd>`,
		`  <current_date>${context.currentDate}</current_date>`,
		"</environment_context>",
	].join("\n");
}

function isEnvironmentContext(value: unknown): value is EnvironmentContext {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.cwd === "string" && typeof candidate.currentDate === "string";
}

export function latestEnvironmentContext(messages: readonly AgentMessage[]): EnvironmentContext | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message.role === "custom" &&
			message.customType === ENVIRONMENT_CONTEXT_MESSAGE_TYPE &&
			isEnvironmentContext(message.details)
		) {
			return message.details;
		}
	}
	return undefined;
}

export function createEnvironmentContextMessage(
	context: EnvironmentContext,
	timestamp: number = Date.now(),
): CustomMessage<EnvironmentContext> {
	return {
		role: "custom",
		customType: ENVIRONMENT_CONTEXT_MESSAGE_TYPE,
		content: formatEnvironmentContext(context),
		display: false,
		details: { cwd: context.cwd, currentDate: context.currentDate },
		timestamp,
	};
}

export function environmentContextMessageIfChanged(
	messages: readonly AgentMessage[],
	current: EnvironmentContext,
): CustomMessage<EnvironmentContext> | undefined {
	const latest = latestEnvironmentContext(messages);
	if (latest?.cwd === current.cwd && latest.currentDate === current.currentDate) return undefined;
	return createEnvironmentContextMessage(current);
}

function contentBlocks(content: string | (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

export function foldEnvironmentContextIntoNextUserMessage(
	messages: readonly Message[],
	environmentMessages: ReadonlySet<Message>,
): Message[] {
	const folded: Message[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const next = messages[index + 1];
		if (
			environmentMessages.has(message) &&
			message.role === "user" &&
			next?.role === "user" &&
			!environmentMessages.has(next)
		) {
			folded.push({ ...next, content: [...contentBlocks(message.content), ...contentBlocks(next.content)] });
			index++;
			continue;
		}
		folded.push(message);
	}
	return folded;
}
