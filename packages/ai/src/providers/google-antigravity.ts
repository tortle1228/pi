import { googleAntigravityApi } from "../api/google-antigravity.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadGoogleAntigravityOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { ANTIGRAVITY_ENDPOINT } from "../utils/antigravity.ts";
import { GOOGLE_ANTIGRAVITY_MODELS } from "./google-antigravity.models.ts";

export function googleAntigravityProvider(): Provider<"google-antigravity"> {
	return createProvider({
		id: "google-antigravity",
		name: "Antigravity",
		baseUrl: ANTIGRAVITY_ENDPOINT,
		auth: {
			oauth: lazyOAuth({
				name: "Antigravity (Google subscription)",
				isSubscription: true,
				loginLabel: "Sign in with Antigravity",
				load: loadGoogleAntigravityOAuth,
			}),
		},
		models: Object.values(GOOGLE_ANTIGRAVITY_MODELS),
		filterModels: (models, credential) => {
			if (credential?.type !== "oauth") return models;
			const ids = credential.availableModelIds;
			if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) return models;
			const available = new Set(ids.map((id) => id.toLowerCase()));
			const filtered = models.filter((model) => available.has(model.id.toLowerCase()));
			// A catalog older than the account's inventory would otherwise show no models at all.
			return filtered.length > 0 ? filtered : models;
		},
		api: googleAntigravityApi(),
	});
}
