import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { googleAntigravityOAuth } from "../src/auth/oauth/google-antigravity.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { googleAntigravityProvider } from "../src/providers/google-antigravity.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CODE_ASSIST_PREFIX = "https://daily-cloudcode-pa.googleapis.com/v1internal:";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function createInteraction(manualInput: string, events: Array<Record<string, unknown>>): ProviderAuthInteraction {
	return {
		signal: new AbortController().signal,
		prompt: async (prompt) => {
			expect(prompt.type).toBe("manual_code");
			return manualInput;
		},
		notify: (event) => events.push(event),
	};
}

function stubCodeAssistFetch(options?: {
	loadCodeAssist?: unknown;
	onboardUser?: unknown;
	availableModels?: unknown;
}): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url === TOKEN_URL) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("client_id")).toContain(".apps.googleusercontent.com");
				expect(params.get("client_secret")).toBeTruthy();
				expect(params.get("code")).toBe("auth-code");
				expect(params.get("code_verifier")).toBeTruthy();
				expect(params.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/oauth-callback$/);
				return jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
			}
			if (url === USERINFO_URL) return jsonResponse({ email: "user@example.com" });
			if (url === `${CODE_ASSIST_PREFIX}loadCodeAssist`) {
				return jsonResponse(options?.loadCodeAssist ?? { cloudaicompanionProject: "managed-project" });
			}
			if (url === `${CODE_ASSIST_PREFIX}onboardUser`) {
				return jsonResponse(options?.onboardUser ?? { done: true, response: {} });
			}
			if (url === `${CODE_ASSIST_PREFIX}fetchAvailableModels`) {
				return jsonResponse(
					options?.availableModels ?? {
						models: {
							"gemini-3.8-flash-high": {},
							tab_completion: {},
							"gemini-4-argon-high-disabled": {},
						},
					},
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Antigravity OAuth", () => {
	it("logs in from a pasted redirect URL and records the account inventory", async () => {
		stubCodeAssistFetch();
		const events: Array<Record<string, unknown>> = [];
		const interaction = createInteraction("http://localhost:51121/oauth-callback?code=auth-code", events);

		const credential = await googleAntigravityOAuth.login(interaction);

		expect(credential).toMatchObject({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			projectId: "managed-project",
			email: "user@example.com",
			availableModelIds: ["gemini-3.8-flash-high"],
		});
		expect(credential.expires).toBeGreaterThan(Date.now());
		const authEvent = events.find((event) => event.type === "auth_url") as { url?: string } | undefined;
		expect(authEvent?.url).toBeDefined();
		const authUrl = new URL(authEvent!.url!);
		expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(authUrl.searchParams.get("client_id")).toContain(".apps.googleusercontent.com");
		expect(authUrl.searchParams.get("response_type")).toBe("code");
		expect(authUrl.searchParams.get("access_type")).toBe("offline");
		expect(authUrl.searchParams.get("prompt")).toBe("consent");
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authUrl.searchParams.get("state")).toBeTruthy();
		expect(authUrl.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/cloud-platform");
		expect(await googleAntigravityOAuth.toAuth(credential)).toEqual({
			apiKey: JSON.stringify({ token: "access-token", projectId: "managed-project" }),
		});
	});

	it("provisions a project when loadCodeAssist returns none", async () => {
		stubCodeAssistFetch({
			loadCodeAssist: { allowedTiers: [{ id: "free-tier", isDefault: true }] },
			onboardUser: { done: true, response: { cloudaicompanionProject: { id: "onboarded-project" } } },
		});

		const credential = await googleAntigravityOAuth.login(
			createInteraction("http://localhost:51121/oauth-callback?code=auth-code", []),
		);

		expect(credential.projectId).toBe("onboarded-project");
	});

	it("keeps project metadata when refreshing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "new-access", expires_in: 3600 })),
		);
		const credential: OAuthCredential = {
			type: "oauth",
			access: "old-access",
			refresh: "refresh-token",
			expires: 0,
			projectId: "managed-project",
			email: "user@example.com",
			availableModelIds: ["gemini-3.8-flash-high"],
		};

		const refreshed = await googleAntigravityOAuth.refresh(credential, new AbortController().signal);

		expect(refreshed).toMatchObject({
			access: "new-access",
			refresh: "refresh-token",
			projectId: "managed-project",
			email: "user@example.com",
			availableModelIds: ["gemini-3.8-flash-high"],
		});
		expect(refreshed.expires).toBeGreaterThan(Date.now());
	});

	it("resolves stored OAuth auth and filters available models through Models", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("google-antigravity", async () => ({
			type: "oauth",
			access: "stored-access",
			refresh: "stored-refresh",
			expires: Date.now() + 3_600_000,
			projectId: "stored-project",
			availableModelIds: ["gemini-3.8-flash-high"],
		}));
		const models = createModels({ credentials: store });
		models.setProvider(googleAntigravityProvider());

		const auth = await models.getAuth("google-antigravity");
		expect(auth?.source).toBe("OAuth");
		expect(auth?.auth.apiKey).toBe(JSON.stringify({ token: "stored-access", projectId: "stored-project" }));

		const available = await models.getAvailable("google-antigravity");
		expect(available.map((model) => model.id)).toEqual(["gemini-3.8-flash-high"]);
	});

	it("rejects credentials without a project ID", async () => {
		const credential: OAuthCredential = { type: "oauth", access: "access", refresh: "refresh", expires: 0 };

		await expect(googleAntigravityOAuth.toAuth(credential)).rejects.toThrow("projectId");
		await expect(googleAntigravityOAuth.refresh(credential, new AbortController().signal)).rejects.toThrow(
			"projectId",
		);
	});
});
