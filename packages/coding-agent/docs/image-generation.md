# Image Generation

The built-in `image` extension adds a `generate_image` tool. The model uses it to create an image from a prompt, or to edit or combine images you point it at, for example: `Make a hero image of a pelican on a bicycle and save it as site/hero.webp`. To turn the extension off, add `-builtin:image` to `extensions` in [settings](settings.md#resources).

## Model and login

The tool uses the model in the [`imageModel`](settings.md) setting, `openai-codex/gpt-6-astra` by default. `openai-codex` image models are `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, and `gpt-6.1-terra`. They use the ChatGPT login (`/login`) and count against its usage limits, not against per-token pricing, so pi shows no cost for them. When the limit is reached, the tool returns the time it resets. Any other image model from a logged-in provider also works.

## Tool arguments

| Argument | Meaning |
|---|---|
| `prompt` | What to create, or how to change the input images. |
| `images` | Up to four image paths (png, jpeg, webp, gif) to edit or use as references. |
| `name` | Short lowercase name for the saved file. Default `image`. |
| `format`, `compression` | `png` (default), `jpeg`, or `webp`; compression 0-100 for jpeg and webp. |
| `transparent` | Transparent background. Needs `png` or `webp`. |
| `output_path` | Where to save, relative to the working directory. The call fails if the file exists. |

Without `output_path`, the image is saved as `NNN-<name>.<ext>` in `<agent dir>/images/<session id>/`, and pi never deletes these files. The result gives the path and shows a preview. Each call makes one image.

## Limits

- The image size cannot be set: new images are about 1536x1024 and edits keep the input size. `quality`, `size`, `input_fidelity`, and masks have no effect on the ChatGPT backend and are not offered.
- The same prompt gives a different image each time, and a model may add details you did not ask for. To keep editing a result, pass its saved path in `images`.
- The model can also run image models from a [`codemode`](codemode.md#generate-images) script with `models.generateImages()`.
