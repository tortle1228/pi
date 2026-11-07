# Web Search

The built-in `web-search` extension adds a `web_search({ query: string })` tool. It supports `zai`, `openai`, and `anthropic`, and experimentally `openai-codex`. To turn it off, add `-builtin:web-search` to `extensions` in [settings](settings.md#resources).

Select a Z.AI, OpenAI, or Anthropic model and ask pi to search, for example: `Search the latest TypeScript release notes and cite the sources.`

The tool reuses the selected provider's credentials and has no separate credential file. Z.AI requires a compatible Coding Plan subscription; OpenAI and Anthropic API searches use API billing. `openai-codex` uses the existing ChatGPT/Codex login and may consume subscription usage. An Anthropic subscription login is experimental and may consume subscription usage or be rejected.

## Availability

The tool enables on session start, model selection, and `/tree` when the selected provider is `zai`, `openai`, `openai-codex`, or `anthropic`, and disables for other providers. Other tools keep their active states. Manually disabling it lasts until the next of those events. Without credentials, the tool remains visible and reports an authentication error when called.

The provider decides availability, so naming the tool does not enable it on an unsupported provider: `"defaultTools": ["+web_search"]` and `--tools read,web_search` have no effect there. To keep it off everywhere, use `"defaultTools": ["-web_search"]`, or `-builtin:web-search` to not load the extension at all. `--tools` also restricts it: `--tools read` leaves it off on every provider.

The provider is checked again when a call starts. An unsupported provider produces an error instead of using another service. A search already in flight continues with the provider and credentials captured when it started.

## Backends

**Z.AI.** Each search resolves credentials at call time and opens its own connection to the official [Web Search MCP](https://docs.z.ai/devpack/mcp/search-mcp-server). It discovers `webSearchPrime` (also accepting `web_search_prime`), checks that the remote schema accepts `{ search_query: query }`, and returns readable content with source links intact. Structured-only results are serialized as JSON. The original MCP tools are not exposed separately. Searches consume Coding Plan allowance. The endpoint is fixed, so if the `zai` provider's `baseUrl` points at another host, such as a proxy, searches fail with an error instead of sending that key to Z.AI.

**OpenAI.** The search uses pi's Responses transports and the selected model to request OpenAI's built-in web search, and returns the answer and source URLs. Models without web search support return an error; there is no automatic model or provider fallback. Codex support is experimental: the subscription backend may reject this request. Searches are independent requests that send only the query, not the conversation. OpenAI API searches incur model and search charges.

**Anthropic.** The search uses pi's Messages transport and the selected model to request Anthropic's server-side `web_search_20260209` tool (dynamic filtering), and returns the answer and source URLs. Models that do not support this tool return an error; there is no automatic model or provider fallback. Searches are independent requests that send only the query, not the conversation. API searches incur model and search charges. Subscription (OAuth) login is experimental: it may consume subscription usage or be rejected.

All searches use a 60-second deadline, support cancellation, and do not automatically retry billable calls. Errors surface as tool errors. Results over 50KB or 2000 lines are truncated, and the result says so.
