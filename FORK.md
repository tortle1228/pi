# Fork Ledger

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi). Upstream sync procedure: [.pi/skills/upstream-sync.md](.pi/skills/upstream-sync.md).

## Upstream

- URL: `https://github.com/earendil-works/pi.git` (fetched by SHA, not configured as a remote)
- Fork point: `469d8651b59069d7bd907c7da84597865e114da6`
- Last reviewed upstream commit: `5ea81d2cd9bb997774b49e379aa5bc496fdfeb6c`
- Ported commits: `git log --grep '^Upstream:' --format='%h %s%n  %(trailers:key=Upstream,valueonly)'`

## Fork Features

A ported change that touches one of these needs the feature's tests too (see the skill).

| Feature | Tests |
|---|---|
| Plan/Build modes, Plan mode bash policy and approvals | `packages/coding-agent/test/suite/agent-mode.test.ts`, `packages/coding-agent/test/interactive-mode-plan-mode.test.ts` |
| `/profile` and the prompt cache kept across Plan/Build switches | `packages/coding-agent/test/suite/agent-mode.test.ts` |
| OpenAI/Codex fast and ultrafast modes, 922K input limits | `packages/ai/test/supports-xhigh.test.ts` |
| `anthropic-api` / `anthropic` provider split, subscription plan limits | `packages/ai/test`, `packages/coding-agent/test` (grep `anthropic-api`) |
| Antigravity provider | `packages/ai/test` (grep `antigravity`) |
| EXAONE provider (`exaone`, `EXAONE_API_KEY`) | `packages/ai/test/stream.test.ts` (grep `exaone`) |
| Web search/fetch backends: Anthropic, xAI, Parallel, Tavily, Exa, Firecrawl, Antigravity | `packages/coding-agent/test` (grep `web-search`) |
| Git worktrees: `--worktree`, `/worktree`, `enter_worktree`, cleanup on quit | `packages/coding-agent/test/worktree.test.ts`, `packages/coding-agent/test/worktree-cli.test.ts`, `packages/coding-agent/test/suite/agent-session-worktree.test.ts`, `packages/coding-agent/test/args.test.ts` |
| Codex image generation: `openai-codex-images` API, `generate_image` tool, `imageModel` setting | `packages/ai/test/openai-codex-images.test.ts`, `packages/coding-agent/test/image-extension.test.ts` |
| Background tasks, shell secret redaction, Claude memory extension | `packages/coding-agent/test` (grep `tasks`, `redact`, `memory`) |
| You should know side agent (`youShouldKnow`, `/you-should-know`) | `packages/coding-agent/test/you-should-know.test.ts`, `packages/coding-agent/test/suite/agent-session-you-should-know.test.ts` |
| `terminal` tool (tmux-style commands, tmux and herdr-core backends, `terminalTool.backends`) | `packages/coding-agent/test/terminal-tool.test.ts`, `packages/coding-agent/test/terminal-commands.test.ts` |

Removed from this fork; never port changes back into them: CHANGELOGs and `/changelog`, upstream contribution files, `durable`, `storage`, `env`, P2, P3, Chord and other apps. Exception: P2's agent `terminal` tool (`apps/p2/plugins/terminals/{commands,tool}.ts`) is ported into `packages/coding-agent/src/extensions/terminal/`; upstream changes to those two files may be ported there.

## Sync Log

### 2026-11: `469d8651b..5ea81d2cd` (123 commits, 13 ported)

Ported unchanged (CHANGELOG and `packages/durable` hunks dropped): `63ea042c`, `1f7c685b`, `6bf2ab9b`, `96667f34`, `5732bac0`, `7860ff52`, `6d3e342b`, `7f47a2ed`, `80d4d3c8`, `acd059b7`, `d448c51e`, `4622edb7`, `7a6bd5a9`.

Skipped:

- 94 not applicable: removed subsystems (P2, P3, Chord, Durable, storage, env, Radius shell, release tags) and their merges.
- 4 docs: changelog and doc-only changes.
- 2 already present: `647a197fc`, `c8d1a826a` (Fireworks test updates; fork has `d16429001`).
- 2 net zero: `5bdf988b7` and its revert `7fd1ee050`.
- 1 not applicable: `136a7b2d7` (licenses directory rename).
- 1 skipped: `9b9cb30ae` (`pi auth login/logout`; conflicts with the fork's provider auth split).

Deferred, review in the next sync:

| Commit | Subject | Why deferred |
|---|---|---|
| `566344046` | fix(ai): retry streams cut short after the reply had begun | Behavior change in retries; not reviewed against fork providers |
| `36142c1c7` | fix(ai,coding-agent): remove "(legacy)" marker from OpenAI Codex provider name | Touches provider naming the fork changed |
| `55a5c6914` | fix(schema): num no longer takes nan and infinity | `packages/schema` is kept; not reviewed |
| `af79b0c3d` | feat(schema): TypeBox parity for extra types | Feature; not reviewed |
| `8a19e8c4a` | fix(scripts): biome-check skips files Biome does not support | Tooling; not reviewed |
| `5c808e17b` | subagent example: ignore the Windows Bun virtual entry path | Windows-only example fix |
