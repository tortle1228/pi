---
name: pi-docs
description: Where Pi's README, docs, and examples live in this checkout. Use when the user asks about the harness, its SDK, extensions, themes, skills, or TUI.
---

# Pi documentation

Read these only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI.

- Main documentation: `packages/coding-agent/README.md`
- Additional docs: `packages/coding-agent/docs/`
- Examples: `packages/coding-agent/examples/` (extensions, custom tools, SDK)
- Resolve `docs/...` under `packages/coding-agent/docs/` and `examples/...` under `packages/coding-agent/examples/`, not the working directory.
- When asked about: extensions (`docs/extensions.md`, `examples/extensions/`), themes (`docs/themes.md`), skills (`docs/skills.md`), prompt templates (`docs/prompt-templates.md`), TUI components (`docs/tui.md`), keybindings (`docs/keybindings.md`), SDK integrations (`docs/sdk.md`), custom providers (`docs/custom-provider.md`), adding models (`docs/models.md`), packages (`docs/packages.md`), environment variables (`docs/environment-variables.md`), MCP servers (`docs/mcp.md`), codemode scripts and non-LLM models such as classifiers and image models (`docs/codemode.md`).
- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.
