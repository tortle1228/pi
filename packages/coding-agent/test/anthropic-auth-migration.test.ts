import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { migrateAnthropicApiKeyCredential } from "../src/migrations.ts";

describe("anthropic api key credential migration", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-anthropic-migration-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	function migrate(auth: Record<string, unknown>): Record<string, unknown> {
		const authPath = path.join(agentDir, "auth.json");
		fs.writeFileSync(authPath, JSON.stringify(auth));
		migrateAnthropicApiKeyCredential();
		return JSON.parse(fs.readFileSync(authPath, "utf-8"));
	}

	it("moves a stored api key to anthropic-api", () => {
		expect(migrate({ anthropic: { type: "api_key", key: "k" } })).toEqual({
			"anthropic-api": { type: "api_key", key: "k" },
		});
	});

	it("keeps OAuth credentials on anthropic", () => {
		const auth = { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } };
		expect(migrate(auth)).toEqual(auth);
	});

	it("does not overwrite an existing anthropic-api credential", () => {
		const auth = {
			anthropic: { type: "api_key", key: "old" },
			"anthropic-api": { type: "api_key", key: "new" },
		};
		expect(migrate(auth)).toEqual(auth);
	});
});
