# Claude Memory

The built-in `claude-memory` extension shares [Claude Code auto memory](https://code.claude.com/docs/en/memory) with pi, so both tools read and write the same `~/.claude/projects/<project>/memory/` directory. It adds no tools or commands and makes no extra model calls.

Nothing needs configuring. Ask pi to remember something, or let the model save what it judges useful in later sessions. To turn it off in pi only, add `-builtin:claude-memory` to `extensions` in [settings](settings.md#resources).

## Behavior

**Reading.** At the start of each run, the extension adds a `claude-memory` system prompt section with the memory directory and the first 200 lines or 25,000 characters of `MEMORY.md`, whichever comes first. These are Claude Code's limits; its docs say 25 KB, but the 2.1.319 binary counts characters. The model reads topic files with `read` when they look relevant.

**Writing.** When the `write` tool is active, the section also tells the model when and how to save. The model decides, and saves with pi's own `write` and `edit` tools. There is no enforcement, so a save is not guaranteed and the model can write elsewhere. Without `write`, the section is read-only, and it is omitted if memory is also empty.

**Project.** Worktrees and subdirectories of a git repository share the main repository's memory, as in Claude Code. Outside git, the current directory is the project.

**Claude Code's opt-outs.** Pi follows the settings that turn Claude Code's memory off:

1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (`1`, `true`, `yes`, or `on` disables; `0`, `false`, `no`, or `off` enables regardless of settings).
2. `autoMemoryEnabled` in `~/.claude/settings.json`, then `<root>/.claude/settings.json`, then `<cwd>/.claude/settings.json`, then `<root>/.claude/settings.local.json`. The last value wins.

`CLAUDE_CONFIG_DIR` relocates `~/.claude`. An empty value counts as unset.

## Limits

- **Memory goes to pi's current model provider.** `MEMORY.md` is sent on every run, and topic files when the model reads them, so memories saved in Claude Code can reach another company's service. Do not keep anything in memory that you would not send there. Setting `autoMemoryEnabled: false` stops this for a project, but also turns memory off in Claude Code.
- **Other models write to Claude's memory.** A wrong or prompt-injected save is loaded by later Claude Code sessions too. Memories are plain files, so you can edit or delete them.
- **No locking.** If Claude Code and pi edit `MEMORY.md` at the same moment, the last write wins.
- **Undocumented path rule.** Claude Code's docs do not specify the directory name. The rule used here (every non-alphanumeric character becomes `-`) comes from the 2.1.319 binary. Encoded paths over 200 characters get a private hash, so the extension skips those projects rather than save where Claude Code cannot read.
- **Not supported:** `autoMemoryDirectory`, `CLAUDE_CODE_PROJECT_DIR_NAME`, and managed policy settings. With either of the first two set, pi and Claude Code use different directories. A managed policy that disables memory does not stop pi.
- **Claude Code only:** background extraction and consolidation are not reimplemented. Consolidation may rewrite what pi saved.
