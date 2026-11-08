// The generate_image tool: create or edit an image with the configured image model.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { ImagesInputContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";

const INPUT_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

const ImageParams = Type.Object({
	prompt: Type.String({ minLength: 1, description: "What to create, or how to change the input images." }),
	name: Type.Optional(
		Type.String({
			pattern: "^[a-z0-9-]{1,40}$",
			description: "Short lowercase name used in the saved file name. Default: image.",
		}),
	),
	images: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			maxItems: 4,
			description: "Paths of images to edit or use as references (png, jpeg, webp, gif).",
		}),
	),
	format: Type.Optional(
		Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], {
			description: "Output format. Default: png.",
		}),
	),
	compression: Type.Optional(
		Type.Integer({ minimum: 0, maximum: 100, description: "Compression level for jpeg and webp." }),
	),
	transparent: Type.Optional(Type.Boolean({ description: "Transparent background. Needs png or webp." })),
	output_path: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Where to save the image, relative to the working directory. Fails if the file exists. Default: the session's image folder.",
		}),
	),
});

/** Next `NNN-` number in a folder of `NNN-name.ext` files. */
function nextNumber(dir: string): number {
	const numbers = readdirSync(dir).map((file) => Number(/^(\d+)-/.exec(file)?.[1] ?? 0));
	return Math.max(0, ...numbers) + 1;
}

export default function image(pi: ExtensionAPI): void {
	const imageModelRef = () => pi.getSettings().imageModel ?? SETTINGS_DEFAULTS.imageModel;
	pi.registerTool(
		defineTool({
			name: "generate_image",
			label: "Generate image",
			description:
				"Create an image from a text prompt, or edit and combine images given in `images`. Saves the result and returns its path and a preview. One image per call.",
			promptSnippet: "Create or edit an image from a prompt",
			promptGuidelines: [
				"Use generate_image for image assets: illustrations, icons, backgrounds, and edits of existing images. For diagrams and exact shapes, write SVG or code instead.",
				"generate_image cannot set the image size (new images are about 1536x1024; edits keep the input size), and the same prompt gives different results each time. Resize afterwards if the size matters.",
				"When the user likes a generate_image result, copy the saved file where it is needed. Do not call generate_image again for the same image; that makes a new one.",
				"Each generate_image call uses the user's image generation allowance. Do not generate variations the user did not ask for.",
			],
			parameters: ImageParams,
			// On only while the image model's provider is logged in; see synchronize below.
			defaultActive: false,
			async execute(_id, params, signal, _onUpdate, ctx) {
				const ref = imageModelRef();
				const slash = ref.indexOf("/");
				const model =
					slash > 0 ? ctx.modelRegistry.findOfType("image", ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
				if (!model) {
					throw new Error(
						`Image model "${ref}" was not found. Set imageModel to an image model as provider/modelId.`,
					);
				}
				const format = params.format ?? "png";

				// Check the target before generating, so a taken path does not cost an image.
				let target = params.output_path ? resolve(ctx.cwd, params.output_path) : undefined;
				if (target && existsSync(target)) {
					throw new Error(`${target} already exists. Choose another output_path.`);
				}

				const input: ImagesInputContent[] = [{ type: "text", text: params.prompt }];
				for (const file of params.images ?? []) {
					const path = resolve(ctx.cwd, file);
					const mimeType = INPUT_MIME_TYPES[extname(path).toLowerCase()];
					if (!mimeType) throw new Error(`${path}: images must be png, jpeg, webp, or gif.`);
					input.push({ type: "image", mimeType, data: readFileSync(path).toString("base64") });
				}

				const result = await ctx.modelRegistry.generateImages(
					model,
					{ input },
					{
						signal,
						metadata: {
							outputFormat: format,
							outputCompression: params.compression,
							background: params.transparent ? "transparent" : undefined,
						},
					},
				);
				const generated = result.output.find((block) => block.type === "image");
				if (result.stopReason !== "stop" || generated?.type !== "image") {
					throw new Error(result.errorMessage ?? "The model returned no image.");
				}

				if (!target) {
					const dir = join(getAgentDir(), "images", ctx.sessionManager.getSessionId());
					mkdirSync(dir, { recursive: true });
					const number = String(nextNumber(dir)).padStart(3, "0");
					target = join(dir, `${number}-${params.name ?? "image"}.${format === "jpeg" ? "jpg" : format}`);
				}
				mkdirSync(dirname(target), { recursive: true });
				const bytes = Buffer.from(generated.data, "base64");
				writeFileSync(target, bytes, { flag: "wx" });

				return {
					content: [
						{
							type: "text",
							text: `Saved ${target} (${bytes.length} bytes, ${generated.mimeType}) from ${model.provider}/${model.id}.`,
						},
						{ type: "image", data: generated.data, mimeType: generated.mimeType },
					],
					details: { path: target, model: `${model.provider}/${model.id}` },
				};
			},
		}),
	);
	const loggedIn = (ctx: ExtensionContext) => {
		const provider = imageModelRef().split("/")[0];
		return provider !== "" && ctx.modelRegistry.getProviderAuthStatus(provider).configured;
	};
	let seenLogin: boolean | undefined;
	const synchronize = (ctx: ExtensionContext) => {
		seenLogin = loggedIn(ctx);
		const active = pi.getActiveTools();
		// An empty set means --no-tools; adding a tool there would override the user's choice.
		if (seenLogin && active.length > 0 && !active.includes("generate_image")) {
			pi.setActiveTools([...active, "generate_image"]);
		} else if (!seenLogin && active.includes("generate_image")) {
			pi.setActiveTools(active.filter((name) => name !== "generate_image"));
		}
	};
	pi.on("session_start", (_event, ctx) => synchronize(ctx));
	// /login and /logout emit no event. Sync only when the login state changed, so a manual disable stays off.
	pi.on("before_agent_start", (_event, ctx) => {
		if (loggedIn(ctx) !== seenLogin) synchronize(ctx);
	});
}
