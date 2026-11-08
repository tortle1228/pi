// The generate_image tool: model lookup, input images, saving, and errors, with a stub model registry.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantImages, ImageModel, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import image from "../src/extensions/image/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

const PNG = Buffer.from("not-really-a-png");

const imageModel: ImageModel<"test-images"> = {
	type: "image",
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	api: "test-images",
	provider: "openai-codex",
	baseUrl: "https://images.test",
	input: ["text", "image"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

interface Call {
	model: ImageModel<string>;
	context: ImagesContext;
	options: ImagesOptions | undefined;
}

let root: string;
let cwd: string;
let calls: Call[];
let reply: AssistantImages;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

function success(): AssistantImages {
	return {
		api: "test-images",
		provider: "openai-codex",
		model: "gpt-6-astra",
		output: [{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }],
		stopReason: "stop",
		timestamp: 0,
	};
}

function tool(settings: { imageModel?: string } = {}) {
	let registered: ToolDefinition<TSchema, unknown, unknown> | undefined;
	// The extension uses only registerTool and getSettings.
	image({
		registerTool: (definition: ToolDefinition<TSchema, unknown, unknown>) => {
			registered = definition;
		},
		getSettings: () => settings,
	} as unknown as ExtensionAPI);
	if (!registered) throw new Error("generate_image was not registered");
	const definition = registered;
	// The tool reads only cwd, the model registry, and the session ID.
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "session-1" },
		modelRegistry: {
			findOfType: (type: string, provider: string, id: string) =>
				type === "image" && provider === "openai-codex" && id === "gpt-6-astra" ? imageModel : undefined,
			generateImages: async (model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions) => {
				calls.push({ model, context, options });
				return reply;
			},
		},
	} as unknown as ExtensionToolContext;
	return (params: Record<string, unknown>) => definition.execute("call-1", params, undefined, undefined, ctx);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-image-ext-"));
	cwd = join(root, "project");
	mkdirSync(cwd);
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	calls = [];
	reply = success();
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	rmSync(root, { recursive: true, force: true });
});

describe("generate_image", () => {
	it("is a built-in extension and defaults to the astra image model", () => {
		expect(builtInExtensions.some((extension) => extension.name === "image")).toBe(true);
		expect(SETTINGS_DEFAULTS.imageModel).toBe("openai-codex/gpt-6-astra");
	});

	it("saves numbered files in the session folder and returns a preview", async () => {
		const run = tool();
		const first = await run({ prompt: "a pelican", name: "pelican" });
		const second = await run({ prompt: "a pelican again", name: "pelican" });

		const dir = join(root, "agent", "images", "session-1");
		expect(readdirSync(dir).sort()).toEqual(["001-pelican.png", "002-pelican.png"]);
		expect(readFileSync(join(dir, "001-pelican.png"))).toEqual(PNG);
		expect(first.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining(join(dir, "001-pelican.png")),
		});
		expect(first.content[1]).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
		expect(second.details).toMatchObject({ path: join(dir, "002-pelican.png"), model: "openai-codex/gpt-6-astra" });
	});

	it("passes the prompt, input images, and output options to the model", async () => {
		writeFileSync(join(cwd, "ref.jpg"), "jpeg-bytes");
		await tool()({ prompt: "make it blue", images: ["ref.jpg"], format: "webp", compression: 40, transparent: true });

		expect(calls).toHaveLength(1);
		expect(calls[0].context.input).toEqual([
			{ type: "text", text: "make it blue" },
			{ type: "image", mimeType: "image/jpeg", data: Buffer.from("jpeg-bytes").toString("base64") },
		]);
		expect(calls[0].options?.metadata).toEqual({
			outputFormat: "webp",
			outputCompression: 40,
			background: "transparent",
		});
	});

	it("saves to output_path and refuses to overwrite before generating", async () => {
		const run = tool();
		await run({ prompt: "logo", output_path: "assets/logo.png" });
		expect(readFileSync(join(cwd, "assets", "logo.png"))).toEqual(PNG);

		await expect(run({ prompt: "logo", output_path: "assets/logo.png" })).rejects.toThrow("already exists");
		expect(calls).toHaveLength(1);
	});

	it("uses the jpg extension for jpeg output", async () => {
		await tool()({ prompt: "photo", format: "jpeg" });
		expect(readdirSync(join(root, "agent", "images", "session-1"))).toEqual(["001-image.jpg"]);
	});

	it("fails when the configured image model does not exist", async () => {
		await expect(tool({ imageModel: "openai-codex/missing" })({ prompt: "x" })).rejects.toThrow("was not found");
		await expect(tool({ imageModel: "nonsense" })({ prompt: "x" })).rejects.toThrow("was not found");
		expect(calls).toHaveLength(0);
	});

	it("fails on an unsupported input image type", async () => {
		writeFileSync(join(cwd, "notes.txt"), "text");
		await expect(tool()({ prompt: "x", images: ["notes.txt"] })).rejects.toThrow("png, jpeg, webp, or gif");
	});

	it("reports the provider error and saves nothing", async () => {
		reply = { ...success(), output: [], stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." };
		await expect(tool()({ prompt: "x" })).rejects.toThrow("usage limit");
		expect(existsSync(join(root, "agent", "images"))).toBe(false);
	});
});
