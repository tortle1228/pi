import { describe, expect, it } from "vitest";
import { SecretOutputRedactor } from "../src/core/tools/secret-output-redactor.ts";

// Fake credentials are assembled at runtime so no credential-shaped literal is committed.
const fake = (prefix: string, body: string) => prefix + body;
const GITHUB = fake("gh" + "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const OPENAI = fake("sk" + "-proj-", "abc123DEF456ghi789JKL012mno345");
const AWS = fake("AK" + "IA", "ABCDEFGHIJ234567");
const SLACK = fake("xo" + "xb-", "123456789012-abcdefghij");
const JWT = `${fake("ey" + "J", "hbGciOiJIUzI1NiJ9")}.${fake("ey" + "J", "zdWIiOiIxMjM0NTY3ODkwIn0")}.dozjgNryP4J3jVmNHl0w5N`;

function redactAll(chunks: string[]): string {
	const redactor = new SecretOutputRedactor();
	return chunks.map((chunk) => redactor.push(chunk)).join("") + redactor.finish();
}

describe("SecretOutputRedactor", () => {
	it.each([
		["GitHub token", `token: ${GITHUB}\n`, "token: <redacted>\n"],
		["OpenAI key", `OPENAI_API_KEY=${OPENAI}\n`, "OPENAI_API_KEY=<redacted>\n"],
		["AWS access key", `aws ${AWS} done\n`, "aws <redacted> done\n"],
		["Slack token", `"${SLACK}"\n`, '"<redacted>"\n'],
		["JWT", `jwt=${JWT}\n`, "jwt=<redacted>\n"],
		[
			"bearer token",
			"Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345\n",
			"Authorization: Bearer <redacted>\n",
		],
		["URL password", "postgres://admin:hunter2secret@db.local/app\n", "postgres://admin:<redacted>@db.local/app\n"],
		["colored token", `\x1b[32m${GITHUB}\x1b[0m\n`, "\x1b[32m<redacted>\x1b[0m\n"],
	])("masks a %s", (_name, input, expected) => {
		expect(redactAll([input])).toBe(expected);
	});

	it("keeps identifiers and ordinary values readable", () => {
		const text = [
			"token_expiry_seconds=3600",
			"max_tokens: 1024",
			"pip install sk-learn-extensions-for-everyone",
			"MY_SECRET_NAME=production",
			"https://example.com/path?a=b",
			"",
		].join("\n");
		expect(redactAll([text])).toBe(text);
	});

	it("masks a credential split across chunks", () => {
		const half = Math.floor(GITHUB.length / 2);
		expect(redactAll([`a ${GITHUB.slice(0, half)}`, `${GITHUB.slice(half)} b\n`])).toBe("a <redacted> b\n");
	});

	it("streams ordinary text at once and holds only a piece that may become a credential", () => {
		const redactor = new SecretOutputRedactor();
		expect(redactor.push("first\nsecond")).toBe("first\nsecond");
		expect(redactor.push(" progress")).toBe(" progress");
		expect(redactor.push(" key gh")).toBe(" key ");
		expect(redactor.push(GITHUB.slice(2))).toBe("");
		expect(redactor.push(" ok")).toBe("<redacted> ok");
		expect(redactor.finish()).toBe("");
	});

	it("masks a bearer token and a URL password split after their introducers", () => {
		const redactor = new SecretOutputRedactor();
		expect(redactor.push("Authorization: Bearer ")).toBe("Authorization: ");
		expect(redactor.push("abcdefghijklmnopqrstuvwxyz012345\n")).toBe("Bearer <redacted>\n");
		expect(redactor.push("url postgres:/")).toBe("url ");
		expect(redactor.push("/admin:hunter2secret@db.local\n")).toBe("postgres://admin:<redacted>@db.local\n");
	});

	it("leaves a private key at a PEM END marker split across chunks", () => {
		const begin = "-----BEGIN " + "PRIVATE KEY-----";
		const output = redactAll([`${begin}\nMIIEow\n-----END `, "PRIVATE KEY-----\nafter\n"]);
		expect(output).toBe("<redacted>\nafter\n");
	});

	it("masks a PEM private key block across lines and chunks", () => {
		const begin = "-----BEGIN RSA " + "PRIVATE KEY-----";
		const end = "-----END RSA " + "PRIVATE KEY-----";
		const output = redactAll(["before\n", `${begin}\nMIIEow`, "IBAAKCAQEA\nabcdef\n", `${end}\nafter\n`]);
		expect(output).toBe("before\n<redacted>\nafter\n");
	});

	it("releases a long line up to a held credential at its end", () => {
		const redactor = new SecretOutputRedactor();
		const long = `${"x".repeat(16 * 1024)} ${GITHUB.slice(0, 10)}`;
		expect(redactor.push(long)).toBe(`${"x".repeat(16 * 1024)} `);
		expect(redactor.push(`${GITHUB.slice(10)}\n`)).toBe("<redacted>\n");
	});
});
