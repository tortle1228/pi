// Execute Z.AI Coding Plan search through a short-lived official MCP connection.
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { Value } from "typebox/value";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { SearchResult } from "./search.ts";

const endpoint = "https://api.z.ai/api/mcp/web_search_prime/mcp";

/** Search with the selected model's credentials, without storing keys or retrying tool calls. */
export async function searchZai(query: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<SearchResult> {
	const model = ctx.model;
	if (!model || model.provider !== "zai") throw new Error("Z.AI search requires the zai provider.");
	// A key configured for another base URL, such as a proxy's, must not be sent to Z.AI's search endpoint.
	if (new URL(model.baseUrl).host !== new URL(endpoint).host) {
		throw new Error(`Z.AI search requires the official endpoint, but the zai provider uses ${model.baseUrl}.`);
	}
	signal?.throwIfAborted();
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error("No Z.AI API key found. Configure the zai provider in pi.");
	return callZaiSearch(query, auth.apiKey, endpoint, signal);
}

/** Run the MCP exchange; an explicit endpoint allows local protocol verification. */
export async function callZaiSearch(
	query: string,
	apiKey: string,
	url: string,
	signal?: AbortSignal,
): Promise<SearchResult> {
	signal?.throwIfAborted();
	const deadline = AbortSignal.timeout(60_000);
	const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const client = new McpClient({ name: "pi-web-search", version: "0.1.0", requestTimeoutMs: 60_000 });
	const transport = new StreamableHttpTransport({
		url,
		headers: { Authorization: `Bearer ${apiKey}` },
		openGetStream: false,
		reconnect: { maxRetries: 0 },
	});
	// connect() has no signal argument, so cancellation closes initialization as well as pending calls.
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= client.close();
		return closing;
	};
	const abort = () => void close().catch(() => {});
	cancellation.addEventListener("abort", abort, { once: true });
	try {
		cancellation.throwIfAborted();
		await client.connect(transport);
		const tools = await client.listTools({ signal: cancellation });
		const tool = tools.find((entry) => entry.name === "webSearchPrime" || entry.name === "web_search_prime");
		if (!tool) throw new Error("Z.AI MCP does not offer webSearchPrime.");
		const args = { search_query: query };
		// Trust boundary: the remote JSON Schema must accept our request before we bill a tool call.
		if (!Value.Check(tool.inputSchema, args)) {
			throw new Error("Z.AI MCP search input schema is incompatible with { search_query: string }.");
		}
		const result = await client.callTool(tool.name, args, { signal: cancellation });
		const text = toLlmContent(result)
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n\n");
		if (result.isError) throw new Error(`Z.AI search failed: ${text || "MCP tool error"}`);
		if (!text.trim()) throw new Error("Z.AI search returned no readable content.");
		return { backend: "zai", text };
	} catch (error) {
		cancellation.throwIfAborted();
		throw error;
	} finally {
		cancellation.removeEventListener("abort", abort);
		await close();
	}
}
