/**
 * Antigravity OAuth flow.
 *
 * Signs in with the Antigravity Google OAuth client, resolves (or provisions)
 * the managed Cloud Code project, and records the account's available model
 * IDs. The access token authenticates Antigravity Cloud Code requests.
 */

import { ANTIGRAVITY_ENDPOINT, getAntigravityUserAgent, getAntigravityVersion } from "../../utils/antigravity.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { sleep } from "../../utils/sleep.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];
// Cloud Code's fallback project for accounts without a managed project.
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";
const DEFAULT_TIER_ID = "free-tier";
const REQUEST_TIMEOUT_MS = 30_000;
const PROJECT_TIMEOUT_MS = 10_000;
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_ATTEMPTS = 10;
const ONBOARD_DELAY_MS = 5_000;

interface TokenResponse {
	access: string;
	refresh: string;
	expires: number;
}

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface OnboardUserPayload {
	done?: boolean;
	response?: { cloudaicompanionProject?: string | { id?: string } };
}

function requestSignal(signal: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const json = await response.json();
		return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a redirect URL; treat the input as the bare code.
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: value };
}

function tokenErrorDetail(json: Record<string, unknown> | null): string {
	const error = typeof json?.error === "string" ? json.error : "";
	const description = typeof json?.error_description === "string" ? json.error_description : "";
	return [error, description].filter(Boolean).join(": ") || "missing token fields";
}

function extractProjectId(value: string | { id?: string } | undefined): string | undefined {
	const id = typeof value === "string" ? value : value?.id;
	const trimmed = id?.trim();
	return trimmed ? trimmed : undefined;
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<TokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}),
		signal: requestSignal(signal),
	});
	const json = await readJson(response);
	const access = json?.access_token;
	const refresh = json?.refresh_token;
	const expiresIn = json?.expires_in;
	if (
		!response.ok ||
		typeof access !== "string" ||
		!access ||
		typeof refresh !== "string" ||
		!refresh ||
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		throw new Error(`Antigravity token exchange failed (status ${response.status}): ${tokenErrorDetail(json)}`);
	}
	return { access, refresh, expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000 };
}

async function getUserEmail(accessToken: string, signal: AbortSignal): Promise<string | undefined> {
	try {
		const response = await fetch(USERINFO_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: requestSignal(signal),
		});
		const json = await readJson(response);
		return response.ok && typeof json?.email === "string" ? json.email : undefined;
	} catch (error) {
		if (signal.aborted) throw error;
		return undefined;
	}
}

function loadCodeAssistHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": getAntigravityUserAgent(),
	};
}

async function loadProject(
	accessToken: string,
	signal: AbortSignal,
): Promise<{ projectId?: string; payload: LoadCodeAssistPayload | null }> {
	try {
		const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers: loadCodeAssistHeaders(accessToken),
			body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
			signal: requestSignal(signal, PROJECT_TIMEOUT_MS),
		});
		if (!response.ok) return { payload: null };
		const payload = (await readJson(response)) as LoadCodeAssistPayload | null;
		return { projectId: extractProjectId(payload?.cloudaicompanionProject), payload };
	} catch (error) {
		if (signal.aborted) throw error;
		return { payload: null };
	}
}

function getDefaultTierId(payload: LoadCodeAssistPayload | null): string {
	const allowedTiers = payload?.allowedTiers ?? [];
	const defaultTier = allowedTiers.find((tier) => tier.isDefault && tier.id);
	return defaultTier?.id ?? allowedTiers[0]?.id ?? payload?.currentTier?.id ?? DEFAULT_TIER_ID;
}

/** Provision a managed project. The operation is polled through repeated POSTs, not an operation GET. */
async function onboardProject(accessToken: string, tierId: string, signal: AbortSignal): Promise<string | undefined> {
	const body = JSON.stringify({
		tier_id: tierId,
		metadata: {
			ide_type: "ANTIGRAVITY",
			ide_version: getAntigravityVersion(),
			ide_name: "antigravity",
		},
	});
	for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:onboardUser`, {
				method: "POST",
				headers: {
					...loadCodeAssistHeaders(accessToken),
					Accept: "*/*",
					"X-Goog-Api-Client": "gl-node/22.21.1",
				},
				body,
				signal: requestSignal(signal, ONBOARD_TIMEOUT_MS),
			});
			if (!response.ok) return undefined;
			const payload = (await readJson(response)) as OnboardUserPayload | null;
			if (payload?.done) return extractProjectId(payload.response?.cloudaicompanionProject);
		} catch (error) {
			if (signal.aborted) throw error;
			return undefined;
		}
		if (attempt < ONBOARD_ATTEMPTS - 1) {
			await sleep(ONBOARD_DELAY_MS, signal);
		}
	}
	return undefined;
}

async function discoverProject(accessToken: string, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	const { projectId, payload } = await loadProject(accessToken, signal);
	if (projectId) return projectId;
	signal.throwIfAborted();
	const onboarded = await onboardProject(accessToken, getDefaultTierId(payload), signal);
	return onboarded ?? DEFAULT_PROJECT_ID;
}

/** Model IDs the account may use. Best-effort; login succeeds without it. */
async function fetchAvailableModelIds(accessToken: string, projectId: string, signal: AbortSignal): Promise<string[]> {
	try {
		const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers: loadCodeAssistHeaders(accessToken),
			body: JSON.stringify({ project: projectId }),
			signal: requestSignal(signal),
		});
		const json = await readJson(response);
		const models = json?.models;
		if (!response.ok || !models || typeof models !== "object") return [];
		return Object.keys(models)
			.filter((id) => /claude|gemini/i.test(id) && !id.endsWith("-disabled"))
			.sort();
	} catch (error) {
		if (signal.aborted) throw error;
		return [];
	}
}

async function loginAntigravity(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const startCallbackServer = (port: number) =>
		startOAuthCallbackServer({
			providerName: "Antigravity",
			host: CALLBACK_HOST,
			port,
			path: CALLBACK_PATH,
			redirectHost: "localhost",
			state: verifier,
			complete: async (code) => code,
			signal: interaction.signal,
		});
	const callback = await startCallbackServer(CALLBACK_PORT)
		.catch(() => startCallbackServer(0))
		.catch(() => undefined);
	const redirectUri = callback?.redirectUri ?? REDIRECT_URI;

	try {
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});
		interaction.notify({
			type: "auth_url",
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete sign-in in your browser. If the browser runs on another machine, paste the final redirect URL here.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
			placeholder: redirectUri,
		});
		let code: string | undefined;
		if (result.type === "callback") {
			code = result.value;
		} else {
			const parsed = parseAuthorizationInput(result.input);
			if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			code = parsed.code;
		}
		if (!code) throw new Error("Missing authorization code");

		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		const token = await exchangeAuthorizationCode(code, verifier, redirectUri, interaction.signal);

		interaction.notify({ type: "progress", message: "Resolving Antigravity project..." });
		const projectId = await discoverProject(token.access, interaction.signal);
		const email = await getUserEmail(token.access, interaction.signal);
		const availableModelIds = await fetchAvailableModelIds(token.access, projectId, interaction.signal);

		return {
			type: "oauth",
			refresh: token.refresh,
			access: token.access,
			expires: token.expires,
			projectId,
			...(email ? { email } : {}),
			...(availableModelIds.length > 0 ? { availableModelIds } : {}),
		};
	} finally {
		callback?.close();
	}
}

async function refreshAntigravityToken(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const projectId = typeof credential.projectId === "string" ? credential.projectId : "";
	if (!projectId) {
		throw new Error("Antigravity credentials are missing projectId. Use /login to re-authenticate.");
	}
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: credential.refresh,
			grant_type: "refresh_token",
		}),
		signal: requestSignal(signal),
	});
	const json = await readJson(response);
	const access = json?.access_token;
	const expiresIn = json?.expires_in;
	const refresh = typeof json?.refresh_token === "string" ? json.refresh_token : credential.refresh;
	if (
		!response.ok ||
		typeof access !== "string" ||
		!access ||
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		throw new Error(`Antigravity token refresh failed (status ${response.status}): ${tokenErrorDetail(json)}`);
	}
	return {
		...credential,
		type: "oauth",
		refresh,
		access,
		expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
	};
}

export const googleAntigravityOAuth: OAuthAuth = {
	name: "Antigravity (Google subscription)",
	isSubscription: true,
	loginLabel: "Sign in with Antigravity",

	login: loginAntigravity,

	refresh: refreshAntigravityToken,

	async toAuth(credential) {
		const projectId = typeof credential.projectId === "string" ? credential.projectId : "";
		if (!projectId) {
			throw new Error("Antigravity credentials are missing projectId. Use /login to re-authenticate.");
		}
		return { apiKey: JSON.stringify({ token: credential.access, projectId }) };
	},
};
