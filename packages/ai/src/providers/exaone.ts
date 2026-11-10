import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { EXAONE_MODELS } from "./exaone.models.ts";

export function exaoneProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "exaone",
		name: "EXAONE",
		baseUrl: "https://api.exaone.ai/v1",
		auth: { apiKey: envApiKeyAuth("EXAONE API key", ["EXAONE_API_KEY"]) },
		models: Object.values(EXAONE_MODELS),
		api: openAICompletionsApi(),
	});
}
