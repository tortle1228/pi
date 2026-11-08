import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalCopilotGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalZaiCodingCnApiKey = process.env.ZAI_CODING_CN_API_KEY;
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalAnthropicOauthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
	if (originalCopilotGitHubToken === undefined) {
		delete process.env.COPILOT_GITHUB_TOKEN;
	} else {
		process.env.COPILOT_GITHUB_TOKEN = originalCopilotGitHubToken;
	}

	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}

	if (originalGitHubToken === undefined) {
		delete process.env.GITHUB_TOKEN;
	} else {
		process.env.GITHUB_TOKEN = originalGitHubToken;
	}

	if (originalZaiCodingCnApiKey === undefined) {
		delete process.env.ZAI_CODING_CN_API_KEY;
	} else {
		process.env.ZAI_CODING_CN_API_KEY = originalZaiCodingCnApiKey;
	}

	if (originalAnthropicAuthToken === undefined) {
		delete process.env.ANTHROPIC_AUTH_TOKEN;
	} else {
		process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
	}

	if (originalAnthropicOauthToken === undefined) {
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
	} else {
		process.env.ANTHROPIC_OAUTH_TOKEN = originalAnthropicOauthToken;
	}

	if (originalAnthropicApiKey === undefined) {
		delete process.env.ANTHROPIC_API_KEY;
	} else {
		process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
	}
});

describe("environment API keys", () => {
	it("does not treat generic GitHub tokens as GitHub Copilot credentials", () => {
		delete process.env.COPILOT_GITHUB_TOKEN;
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toBeUndefined();
		expect(getEnvApiKey("github-copilot")).toBeUndefined();
	});

	it("resolves GitHub Copilot credentials from COPILOT_GITHUB_TOKEN", () => {
		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN"]);
		expect(getEnvApiKey("github-copilot")).toBe("copilot-token");
	});

	it("resolves ZAI China Coding Plan credentials from ZAI_CODING_CN_API_KEY", () => {
		process.env.ZAI_CODING_CN_API_KEY = "zai-coding-cn-token";

		expect(findEnvKeys("zai-coding-cn")).toEqual(["ZAI_CODING_CN_API_KEY"]);
		expect(getEnvApiKey("zai-coding-cn")).toBe("zai-coding-cn-token");
	});

	it("reports ANTHROPIC_AUTH_TOKEN for anthropic-api but returns the API key", () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
		process.env.ANTHROPIC_API_KEY = "api-key";

		expect(findEnvKeys("anthropic-api")).toEqual(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
		expect(getEnvApiKey("anthropic-api")).toBe("api-key");
	});

	it("does not return ANTHROPIC_AUTH_TOKEN as an API key", () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		delete process.env.ANTHROPIC_API_KEY;

		expect(findEnvKeys("anthropic-api")).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
		expect(getEnvApiKey("anthropic-api")).toBeUndefined();
	});

	it("reads only ANTHROPIC_OAUTH_TOKEN for the anthropic subscription provider", () => {
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
		process.env.ANTHROPIC_API_KEY = "api-key";

		expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_OAUTH_TOKEN"]);
		expect(getEnvApiKey("anthropic")).toBe("oauth-token");
	});
});
