# Web Search

The built-in `web-search` extension adds a `web_search({ query: string })` tool. It supports `zai`, `openai`, `anthropic`, and `xai`, and experimentally `openai-codex`. On `xai` it also adds `x_search({ query: string })`, which searches posts on X. `web_search` and `web_fetch` follow `webSearch.order` (default `native`, `parallel`, `tavily`): a backend that is unavailable is skipped, and a failure tries the next one unless the call was cancelled. Parallel and Tavily need a key saved with `/login parallel` or `/login tavily`. `web_research` is Parallel only. To turn the extension off, add `-builtin:web-search` to `extensions` in [settings](settings.md#resources).

Select a Z.AI, OpenAI, Anthropic, or xAI model and ask pi to search, for example: `Search the latest TypeScript release notes and cite the sources.` On xAI, ask for posts on X to use `x_search`. After `/login parallel` or `/login tavily`, the same request works on any other provider.

Native tools reuse the selected provider's credentials and have no separate credential file. Z.AI requires a compatible Coding Plan subscription; OpenAI, Anthropic, and xAI API searches use API billing. `openai-codex` uses the existing ChatGPT/Codex login and may consume subscription usage. An Anthropic or xAI subscription login is experimental and may consume subscription usage or be rejected. Parallel and Tavily keys are saved with `/login` in [`auth.json`](configuration.md#agent-directory) and removed with `/logout`. A `!command` key works the same way as for other providers. Environment variables are not read.

## Availability

`web_search` enables on session start, model selection, `/tree`, and the next prompt after `/login` when `webSearch.order` has an available backend, and disables otherwise. `x_search` enables only for `xai`. `web_fetch` enables when that order names Parallel or Tavily and that login is saved. `web_research` enables only after `/login parallel`. Other tools keep their active states. Manually disabling one lasts until the next of those events. Without credentials, a visible tool reports an authentication error when called.

Naming a tool does not enable it when its backend is unavailable: `"defaultTools": ["+web_search"]` and `--tools read,web_search` have no effect on a provider without native search unless a later backend is logged in, `+web_fetch` has no effect without `/login parallel` or `/login tavily`, `+web_research` has no effect without `/login parallel`, and `+x_search` has no effect except on `xai`. To keep one off, use `"defaultTools": ["-web_search"]`, `["-web_fetch"]`, `["-web_research"]`, or `["-x_search"]`. `-builtin:web-search` does not load the extension at all. `--tools` also restricts them: `--tools read` leaves them off on every provider.

`webSearch.order` is a list of `native`, `parallel`, and `tavily`. The default is `["native", "parallel", "tavily"]`. A project setting replaces the user list. A backend missing from the list is not used. Unknown entries are ignored.

```json
{
  "webSearch": { "order": ["tavily", "native", "parallel"] }
}
```

The provider and the saved keys are checked again when a call starts. With no available backend, the call errors instead of using another service. A failure tries the next available backend once, unless the caller cancelled. A search already in flight continues with the backend and credentials captured when it started. A backend can be billed before it fails, so a fallback can be charged again. A backend that is not tried is not billed.

## Backends

**Z.AI.** Each search resolves credentials at call time and opens its own connection to the official [Web Search MCP](https://docs.z.ai/devpack/mcp/search-mcp-server). It discovers `webSearchPrime` (also accepting `web_search_prime`), checks that the remote schema accepts `{ search_query: query }`, and returns readable content with source links intact. Structured-only results are serialized as JSON. The original MCP tools are not exposed separately. Searches consume Coding Plan allowance. The endpoint is fixed, so if the `zai` provider's `baseUrl` points at another host, such as a proxy, searches fail with an error instead of sending that key to Z.AI. That error continues with the next backend in `webSearch.order` when one is available.

**OpenAI.** The search uses pi's Responses transports and the selected model to request OpenAI's built-in web search, and returns the answer and source URLs. Models without web search support return an error, and that error continues with the next backend in `webSearch.order` when one is available. Codex support is experimental: the subscription backend may reject this request. Searches are independent requests that send only the query, not the conversation. OpenAI API searches incur model and search charges.

**xAI.** `web_search` and `x_search` use pi's Responses transport and the selected model to request xAI's server-side `web_search` or `x_search` tool, and return the answer and source URLs. Models that do not support the tool return an error. A failed `web_search` continues with the next backend in `webSearch.order` when one is available. `x_search` has no fallback. Searches are independent requests that send only the query, not the conversation. API searches incur model and search charges. Subscription (OAuth) login follows the provider's existing auth and is experimental.

**Anthropic.** The search uses pi's Messages transport and the selected model to request Anthropic's server-side `web_search_20260209` tool (dynamic filtering), and returns the answer and source URLs. Models that do not support this tool return an error, and that error continues with the next backend in `webSearch.order` when one is available. Searches are independent requests that send only the query, not the conversation. API searches incur model and search charges. Subscription (OAuth) login is experimental: it may consume subscription usage or be rejected.

**Parallel.** Run `/login parallel` and paste a key from [platform.parallel.ai](https://platform.parallel.ai). `web_search` calls `POST /v1/search` with `mode: "fast"` and the query as both the objective and the only keyword query. `web_fetch({ urls, objective? })` calls `POST /v1/extract` for up to 20 http(s) URLs and returns excerpts, or an error line for each URL that failed. `web_research({ query, effort?, previous_response_id? })` calls `POST /v1/responses` with `model: "parallel"`. `effort` is `low`, `medium`, or `high` and defaults to `medium`. The result is the answer, source URLs, and `Response ID`. A follow-up passes that id as `previous_response_id`; this does not work when the organization has Zero Data Retention enabled. The research question is sent alone, so it must stand on its own. Auth is the `x-api-key` header. Parallel calls are not retried on their own; the order may try Tavily after a failure.

**Tavily.** Run `/login tavily` and paste a key from [app.tavily.com](https://app.tavily.com). `web_search` calls `POST https://api.tavily.com/search` with `search_depth: "basic"` and sends only the query. `web_fetch` calls `POST https://api.tavily.com/extract` for the same http(s) URLs and passes `objective` as `query` when it is set. A URL that fails is an error line. Auth is the `Authorization: Bearer` header. Tavily calls are not retried on their own. Tavily has no research tool here, so `web_research` stays off when only Tavily is logged in.

Native searches and Parallel and Tavily search and fetch use a 60-second deadline. Parallel research uses 120 seconds. All of them support cancellation and do not automatically retry billable calls. Errors surface as tool errors. Results over 50KB or 2000 lines are truncated, and the result says so.
