# Fork Ledger

Personal fork of [earendil-works/pi](https://github.com/earendil-works/pi). Upstream sync procedure: [.pi/skills/upstream-sync.md](.pi/skills/upstream-sync.md).

## Upstream

- URL: `https://github.com/earendil-works/pi.git` (fetched by SHA, not configured as a remote)
- Fork point: `469d8651b59069d7bd907c7da84597865e114da6`
- Last reviewed upstream commit: `dd30101cfc5b0609411dd80b6f93adbc14db14cf` (v1.5.1)
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
| EXAONE rate limits in the footer (`exaone-limits`), `provider`/`model` on `after_provider_response` | `packages/coding-agent/test/exaone-limits-extension.test.ts` |
| Web search/fetch backends: Anthropic, xAI, Parallel, Tavily, Exa, Firecrawl, Antigravity | `packages/coding-agent/test` (grep `web-search`) |
| Git worktrees: `--worktree`, `/worktree`, `enter_worktree`, cleanup on quit | `packages/coding-agent/test/worktree.test.ts`, `packages/coding-agent/test/worktree-cli.test.ts`, `packages/coding-agent/test/suite/agent-session-worktree.test.ts`, `packages/coding-agent/test/args.test.ts` |
| Codex image generation: `openai-codex-images` API, `generate_image` tool, `imageModel` setting | `packages/ai/test/openai-codex-images.test.ts`, `packages/coding-agent/test/image-extension.test.ts` |
| Background tasks, shell secret redaction, Claude memory extension | `packages/coding-agent/test` (grep `tasks`, `redact`, `memory`) |
| You should know side agent (`youShouldKnow`, `/you-should-know`) | `packages/coding-agent/test/you-should-know.test.ts`, `packages/coding-agent/test/suite/agent-session-you-should-know.test.ts` |
| `terminal` tool (tmux-style commands, tmux and herdr-core backends, `terminalTool.backends`) | `packages/coding-agent/test/terminal-tool.test.ts`, `packages/coding-agent/test/terminal-commands.test.ts` |

Removed from this fork; never port changes back into them: CHANGELOGs and `/changelog`, upstream contribution files, `durable`, `storage`, `env`, P2, P3, Chord and other apps. Exception: P2's agent `terminal` tool (`apps/p2/plugins/terminals/{commands,tool}.ts`) is ported into `packages/coding-agent/src/extensions/terminal/`; upstream changes to those two files may be ported there.

## Sync Log

### 2026-11: `5ea81d2cd..dd30101cf` (v1.5.1, 56 commits plus 6 deferred, 17 ported)

Package versions stay at 1.5.0: the fork is used locally only, and this ledger records the upstream base.

Ported unchanged (CHANGELOG hunks dropped): `af79b0c3d`, `55a5c6914`, `36142c1c7`, `8a19e8c4a`, `5c808e17b`, `566344046` (previously deferred); `33cd7e507`, `a77207d9c`, `45344bd3a`, `ea1cfcc4c`, `6382d8706`, `c9dd2c530`, `244e5f5db`, `463b8f893`, `a07f25129`.

Adapted:

- `7bcc15c92` (cacheWarming default `idle`): conflict with the fork's `webSearch` defaults resolved by hand.
- `0d1793c2b` (Claude Fable 5.2): added in `defineAnthropicProvider`, so `anthropic` and `anthropic-api` both get it.

Skipped:

- 39 not applicable: P2, P3, Chord, Durable and their docs.
- 4 docs: changelog and doc-only changes (`e370b44b5`, `77959d667`, `6a1703946`, `9abcd30f6`).
- 1 release: `dd30101cf` (version bump; versions stay as they are).
- 1 skipped: `683a7a868` (partner providers first in `/login`; partner promotion, conflicts with the fork's provider split).

### 2026-11: `469d8651b..5ea81d2cd` (123 commits, 13 ported)

Ported unchanged (CHANGELOG and `packages/durable` hunks dropped): `63ea042c`, `1f7c685b`, `6bf2ab9b`, `96667f34`, `5732bac0`, `7860ff52`, `6d3e342b`, `7f47a2ed`, `80d4d3c8`, `acd059b7`, `d448c51e`, `4622edb7`, `7a6bd5a9`.

Skipped:

- 94 not applicable: removed subsystems (P2, P3, Chord, Durable, storage, env, Radius shell, release tags) and their merges.
- 4 docs: changelog and doc-only changes.
- 2 already present: `647a197fc`, `c8d1a826a` (Fireworks test updates; fork has `d16429001`).
- 2 net zero: `5bdf988b7` and its revert `7fd1ee050`.
- 1 not applicable: `136a7b2d7` (licenses directory rename).
- 1 skipped: `9b9cb30ae` (`pi auth login/logout`; conflicts with the fork's provider auth split).

Deferred: 6 commits, all resolved in the v1.5.1 sync below.
