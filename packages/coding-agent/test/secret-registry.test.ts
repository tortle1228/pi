import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { RuntimeCredentials } from "../src/core/runtime-credentials.ts";
import {
	isSecretName,
	knownSecrets,
	partialSecretSuffixLength,
	registerConfiguredSecret,
	registerKnownSecret,
	registerNamedSecret,
} from "../src/core/secret-registry.ts";
import { SecretOutputRedactor } from "../src/core/tools/secret-output-redactor.ts";
import { createDefaultTransport } from "../src/extensions/mcp/runtime.ts";

// Assembled at runtime so no secret-shaped literal is committed.
const EXA_KEY = `exa-${"a1b2c3d4e5f6g7h9".repeat(2)}`;
const TVLY_KEY = `tvly-${"0123456789abcdef".repeat(2)}`;

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("secret registry", () => {
	it("skips short values and reference specs", () => {
		registerKnownSecret("short");
		registerKnownSecret(`${EXA_KEY}\nsecond-line`);
		registerConfiguredSecret("$EXA_API_KEY");
		registerConfiguredSecret("!op read op://vault/key");
		registerConfiguredSecret(`prefix-\${VAR}-suffix`);
		registerConfiguredSecret(EXA_KEY);
		expect(knownSecrets()).toContain(EXA_KEY);
		expect(knownSecrets()).not.toContain("short");
		expect(knownSecrets()).not.toContain("$EXA_API_KEY");
	});

	it("registers values whose configured name says they are secrets", () => {
		registerNamedSecret("GITHUB_TOKEN", TVLY_KEY);
		registerNamedSecret("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin");
		expect(knownSecrets()).toContain(TVLY_KEY);
		expect(knownSecrets().some((value) => value.startsWith("/usr"))).toBe(false);
	});

	it("matches whole words of a name, not parts of other words", () => {
		for (const name of [
			"GITHUB_TOKEN",
			"X-Api-Key",
			"APIKEY",
			"Authorization",
			"cf-aig-authorization",
			"authToken",
		]) {
			expect(isSecretName(name)).toBe(true);
		}
		for (const name of ["GIT_AUTHOR_EMAIL", "MONKEY_PATCH", "KEYBOARD_LAYOUT", "PATH"]) {
			expect(isSecretName(name)).toBe(false);
		}
	});

	it("registers the token behind an Authorization scheme", () => {
		const token = "plain-opaque-token-behind-scheme";
		registerNamedSecret("Authorization", `Bearer ${token}`);
		expect(new SecretOutputRedactor().push(`TOKEN=${token}\n`)).toBe("TOKEN=<redacted>\n");
	});

	it("measures the suffix that may still grow into a secret", () => {
		registerKnownSecret(EXA_KEY);
		expect(partialSecretSuffixLength(`value "exa-a1b2c3d4`)).toBe("exa-a1b2c3d4".length);
		expect(partialSecretSuffixLength("no partial here\n")).toBe(0);
	});
});

describe("SecretOutputRedactor with registered values", () => {
	it("masks a registered value no credential shape covers", () => {
		registerKnownSecret(EXA_KEY);
		expect(new SecretOutputRedactor().push(`"apiKey": "${EXA_KEY}"\n`)).toBe(`"apiKey": "<redacted>"\n`);
	});

	it("masks a registered value split across chunks", () => {
		registerKnownSecret(TVLY_KEY);
		const redactor = new SecretOutputRedactor();
		const split = Math.floor(TVLY_KEY.length / 2);
		const first = redactor.push(`key=${TVLY_KEY.slice(0, split)}`);
		expect(first).not.toContain(TVLY_KEY.slice(0, split));
		const rest = redactor.push(`${TVLY_KEY.slice(split)} and done\n`);
		expect(first + rest).toBe("key=<redacted> and done\n");
	});
});

describe("secret registration from pi's own configuration", () => {
	it("registers api keys and OAuth tokens an auth file holds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-secret-registry-"));
		tempDirs.push(dir);
		const authPath = join(dir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				example: { type: "api_key", key: EXA_KEY },
				oauthed: { type: "oauth", access: TVLY_KEY, refresh: `rf-${"ff00".repeat(6)}`, expires: 1 },
			}),
		);
		const storage = AuthStorage.create(authPath);
		await expect(storage.read("example")).resolves.toMatchObject({ key: EXA_KEY });
		expect(knownSecrets()).toContain(EXA_KEY);
		expect(knownSecrets()).toContain(TVLY_KEY);
	});

	it("keeps the other credentials when an auth file entry is malformed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-secret-registry-"));
		tempDirs.push(dir);
		const authPath = join(dir, "auth.json");
		const key = `kept-${"0123456789abcdef".repeat(2)}`;
		writeFileSync(
			authPath,
			JSON.stringify({ broken: null, numeric: { type: "api_key", key: 123 }, kept: { type: "api_key", key } }),
		);
		await expect(AuthStorage.create(authPath).read("kept")).resolves.toMatchObject({ key });
		expect(knownSecrets()).toContain(key);
	});

	it("registers resolved MCP values, even ones that look like references", () => {
		const password = "!resolved-password-value";
		const token = "resolved-mcp-header-token-value";
		createDefaultTransport(
			{ name: "stdio", config: { command: "node", env: { DB_PASSWORD: `$${password}` } }, source: "test" },
			"/",
			undefined,
		);
		createDefaultTransport(
			{
				name: "http",
				config: { url: "http://localhost:1", headers: { Authorization: `Bearer ${token}` } },
				source: "test",
			},
			"/",
			undefined,
		);
		expect(knownSecrets()).toContain(password);
		expect(knownSecrets()).toContain(token);
	});

	it("registers configured provider headers, but not unresolved provider env references", async () => {
		const header = "configured-provider-header-value";
		const reference = "$PROVIDER_ENV_REFERENCE_NAME";
		const credentials = AuthStorage.inMemory({
			"secret-header-provider": { type: "api_key", key: "provider-key", env: { MY_TOKEN: reference } },
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		runtime.registerProvider("secret-header-provider", {
			baseUrl: "https://example.com",
			api: "openai-completions",
			authHeader: true,
			headers: { "X-Api-Key": header },
			models: [
				{
					id: "m",
					name: "m",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10000,
					maxTokens: 1000,
				},
			],
		});
		await runtime.getAuth(runtime.getModel("secret-header-provider", "m")!);
		expect(knownSecrets()).toContain(header);
		expect(knownSecrets()).not.toContain(reference);
	});

	it("registers a runtime API key", async () => {
		const runtime = new RuntimeCredentials(AuthStorage.inMemory({}));
		runtime.setRuntimeApiKey("example", EXA_KEY);
		await expect(runtime.read("example")).resolves.toMatchObject({ key: EXA_KEY });
		expect(knownSecrets()).toContain(EXA_KEY);
	});
});
