/**
 * Antigravity client identity shared by the adapter, OAuth flow, and model
 * catalog. The backend gates newer models on the Hub User-Agent version.
 */

import { getProviderEnvValue } from "./provider-env.ts";

export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

const DEFAULT_ANTIGRAVITY_VERSION = "2.24.0";
const ANTIGRAVITY_HUB_CHANGELISTS: Readonly<Record<string, string>> = {
	"2.23.0": "998057262",
	"2.23.1": "998881661",
	"2.24.0": "1000335682",
};

export function getAntigravityVersion(): string {
	return getProviderEnvValue("PI_AI_ANTIGRAVITY_VERSION") || DEFAULT_ANTIGRAVITY_VERSION;
}

export function getAntigravityUserAgent(): string {
	const version = getAntigravityVersion();
	const changelist = ANTIGRAVITY_HUB_CHANGELISTS[version];
	return `antigravity/hub/${version} (aidev_client; os_type=darwin; arch=arm64${changelist ? `; cl=${changelist}` : ""})`;
}
