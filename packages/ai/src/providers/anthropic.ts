import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadAnthropicOAuth } from "../auth/oauth/load.ts";
import { ANTHROPIC_OAUTH_TOKEN_ENV } from "../env-api-keys.ts";
import { createProvider, type Provider } from "../models.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: {
			apiKey: envApiKeyAuth("Anthropic OAuth token", [ANTHROPIC_OAUTH_TOKEN_ENV]),
			oauth: lazyOAuth({
				name: "Anthropic (Claude Pro/Max)",
				isSubscription: true,
				load: loadAnthropicOAuth,
			}),
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(),
	});
}
