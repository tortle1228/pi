# Web Search

The built-in `web-search` extension adds a `web_search({ query: string })` tool. It supports `zai`, `openai`, `anthropic`, and `xai`, and experimentally `openai-codex`. On `xai` it also adds `x_search({ query: string })`, which searches posts on X. To turn both off, add `-builtin:web-search` to `extensions` in [settings](settings.md#resources).

Select a Z.AI, OpenAI, Anthropic, or xAI model and ask pi to search, for example: `Search the latest TypeScript release notes and cite the sources.` On xAI, ask for posts on X to use `x_search`.

The tools reuse the selected provider's credentials and have no separate credential file. Z.AI requires a compatible Coding Plan subscription; OpenAI, Anthropic, and xAI API searches use API billing. `openai-codex` uses the existing ChatGPT/Codex login and may consume subscription usage. An Anthropic or xAI subscription login is experimental and may consume subscription usage or be rejected.

## Availability

`web_search` enables on session start, model selection, and `/tree` when the selected provider is `zai`, `openai`, `openai-codex`, `anthropic`, or `xai`, and disables for other providers. `x_search` enables only for `xai`. Other tools keep their active states. Manually disabling either lasts until the next of those events. Without credentials, a visible tool reports an authentication error when called.

The provider decides availability, so naming a tool does not enable it on an unsupported provider: `"defaultTools": ["+web_search"]` and `--tools read,web_search` have no effect there, and `+x_search` has no effect except on `xai`. To keep one off, use `"defaultTools": ["-web_search"]` or `["-x_search"]`. `-builtin:web-search` does not load the extension at all. `--tools` also restricts them: `--tools read` leaves both off on every provider.

The provider is checked again when a call starts. An unsupported provider produces an error instead of using another service. A search already in flight continues with the provider and credentials captured when it started.

## Backends

**Z.AI.** Each search resolves credentials at call time and opens its own connection to the official [Web Search MCP](https://docs.z.ai/devpack/mcp/search-mcp-server). It discovers `webSearchPrime` (also accepting `web_search_prime`), checks that the remote schema accepts `{ search_query: query }`, and returns readable content with source links intact. Structured-only results are serialized as JSON. The original MCP tools are not exposed separately. Searches consume Coding Plan allowance. The endpoint is fixed, so if the `zai` provider's `baseUrl` points at another host, such as a proxy, searches fail with an error instead of sending that key to Z.AI.

**OpenAI.** The search uses pi's Responses transports and the selected model to request OpenAI's built-in web search, and returns the answer and source URLs. Models without web search support return an error; there is no automatic model or provider fallback. Codex support is experimental: the subscription backend may reject this request. Searches are independent requests that send only the query, not the conversation. OpenAI API searches incur model and search charges.

**xAI.** `web_search` and `x_search` use pi's Responses transport and the selected model to request xAI's server-side `web_search` or `x_search` tool, and return the answer and source URLs. Models that do not support the tool return an error; there is no automatic model or provider fallback. Searches are independent requests that send only the query, not the conversation. API searches incur model and search charges. Subscription (OAuth) login follows the provider's existing auth and is experimental.

**Anthropic.** The search uses pi's Messages transport and the selected model to request Anthropic's server-side `web_search_20260209` tool (dynamic filtering), and returns the answer and source URLs. Models that do not support this tool return an error; there is no automatic model or provider fallback. Searches are independent requests that send only the query, not the conversation. API searches incur model and search charges. Subscription (OAuth) login is experimental: it may consume subscription usage or be rejected.

All searches use a 60-second deadline, support cancellation, and do not automatically retry billable calls. Errors surface as tool errors. Results over 50KB or 2000 lines are truncated, and the result says so.
