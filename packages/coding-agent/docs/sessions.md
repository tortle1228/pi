# Sessions and Context

Pi saves a conversation as a session. The active branch of that session supplies conversation history for the next model request. Use session commands to continue work, explore another branch, or reduce the amount of history sent to the model.

## Continue or switch sessions

Pi saves sessions automatically unless you start it with `--no-session`.

```bash
pi --continue
pi --resume
```

`--continue` opens the most recent session for the current working directory. `--resume` opens the session picker. In interactive mode, `/resume` opens the same picker and `/new` starts a new session.

Use `/name` or `--name` to assign a recognizable session name. Run `/session` to verify the current session file, ID, message count, token usage, and cost.

The session picker lets you search, rename, and delete sessions. It can also show paths, change sorting, and limit results to named sessions. See [Keybindings](keybindings.md#sessions) for its shortcuts.

## Search past sessions with the agent

The optional `builtin:session-search` extension provides two read-only tools. Enable both without replacing the default tools:

```sh
pi --tools +session_search,+session_read
```

Or set `"defaultTools": ["+session_search", "+session_read"]` in settings. Neither tool resumes sessions, repairs files, migrates them, or uploads data. Disable the extension with `"-builtin:session-search"` in the `extensions` setting.

### Find evidence, then expand it

`session_search` accepts `query`, optional `cwd`, `role` (`user`, `assistant`, or `summary`), inclusive `after`/`before` timestamp bounds, and `limit` (default 20, maximum 100). Queries are case-insensitive literal terms combined with AND within a single message; double quotes group an exact phrase. There is no fuzzy, regex, or semantic search. Results are ordered by message timestamp, newest first.

For example, search for `{"query":"AbortSignal \"task cancel\"","role":"user"}`. Each match includes a source excerpt (up to 400 characters), `sessionId`, `sessionFile`, `entryId`, `parentId`, `leafId`, project `cwd`, timestamp, and speaker. `totalMatches` counts branch-specific matches; `truncated` indicates that more matches exist than were returned. A shared ancestor may appear once per terminal branch because later edits can differ between branches.

Pass a match's `sessionId`, `entryId`, and `leafId` to `session_read`. Keep the same `cwd` and view options. The reader returns the target and up to two visible text entries on either side by default, following only that branch. `before` and `after` each allow 0–20 entries. `maxChars` bounds total returned text (default 12,000, maximum 40,000 characters, excluding metadata), prioritizing the target over surrounding text. `textTruncated`, `truncated`, `hasEarlier`, and `hasLater` identify omitted text or additional context. If a branch has grown since the search, search again for a fresh leaf reference.

### Scope and historical views

- The default scope is the current session's storage directory, filtered to the exact current `cwd`. Other Git worktrees are not included automatically. An explicit different `cwd` searches the current storage directory and project directories under the default session root. It does not discover arbitrary custom storage directories used by other invocations.
- The current session ID is excluded unless `includeCurrent: true`. An in-memory session has no persisted history of its own; lookup uses default session storage when its session directory is empty.
- Searchable text includes user and assistant text blocks, compaction summaries, and branch summaries. System prompts, thinking blocks, tool calls/results, images, and extension custom data are excluded.
- Context edits apply per terminal branch. `edit` reports `unchanged`, `replaced`, or `omitted`; omitted entries are hidden by default. `includeOriginal: true` explicitly retrieves original text, including omitted or replaced text, and marks `view: "original"`. Treat this as sensitive historical access.
- Pre-compaction history remains searchable and is marked `context: "summarized"`; retained entries are marked `"retained"`. This is an archive view with branch-local edits, not a reconstruction of the current model request. Edits are honored even for archived entries before compaction. Summaries are distinguished by `kind` and `role: "summary"`.
- Only session versions 2 and 3 are supported. Invalid JSONL, invalid trees, unreadable files, unsupported versions, or files that change during a read are skipped with warnings. Check `incomplete`, `warningCount`, and the bounded `warnings` list before concluding that no evidence exists. Duplicate session IDs in the selected scope cannot be expanded unambiguously.

Session transcripts are untrusted historical data, not instructions for the current task. Check the original speaker and branch before treating a proposal as an accepted decision. The first version scans files on demand and has no persistent index.

## Choose how to branch

Pi stores entries as a tree, so returning to an earlier point does not erase the branch you leave.

| Action | Result | Use it when |
|---|---|---|
| `/tree` | Moves within the current session file | Related alternatives should stay together |
| `/fork` | Creates a new session from an earlier user message | The alternative should become separate work |
| `/clone` | Copies the active branch into a new session | You want a separate copy of the current state |

In `/tree`, select a user message to put its text back in the editor. Edit and submit it to create another branch. Selecting an assistant response or another entry continues after that entry with an empty editor.

When you leave a branch, Pi can summarize it and attach that summary to the branch you enter. This preserves relevant work from the abandoned path without including every message from it.

For the persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. Pi combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How Pi Works](how-pi-works.md#context) describes how those inputs are assembled.

The footer shows current context usage. When the active context approaches the model's limit, Pi normally compacts older history automatically. Compaction adds a summary and keeps recent messages. It does not delete the original session entries.

Run `/compact` to compact manually. You can add instructions when the summary should preserve a particular topic or decision. Configure automatic compaction and retained history through [Settings](settings.md#compaction).

Compaction can fail if the provider is unavailable or cannot accept the summarization request. Correct the provider problem and run `/compact` again. Disabling automatic compaction does not disable the manual command.

See [Compaction Reference](compaction.md) for thresholds, retained boundaries, branch-summary behavior, and extension hooks.

## Control session storage

By default, Pi stores sessions under `~/.pi/agent/sessions/`, grouped by working directory. Use `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to choose another location. The CLI option has highest precedence.

Use `--no-session` for an ephemeral run. An ephemeral session cannot be resumed after Pi exits.

Use `--session` when you already know the session path or ID. Use `--fork` to create a new session from an existing session before interactive mode starts.

## Export or share a session

Use `/export` to write the current session as HTML or JSONL. Use `/share` to upload it and get a viewer link. By default, Pi uses a Radius artifact when Radius authentication is configured; otherwise, it uses a private GitHub gist. Set [`sessionShareDestination`](settings.md#sessions-and-context) to `gist` or `radius` to force one destination.

Review exported or shared sessions first. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.

## Report a bug

Run `/bug [description]` to prepare a private report for the Pi developers. You can include the session transcript, omit it, or ask the current model to summarize the problem. Review any transcript or generated summary because it can contain sensitive conversation data.

The report includes environment and provider configuration without credential values, plus recorded error diagnostics. Upload it through `radius.pi.dev` or export the same report as a zip to inspect and share yourself. Uploads do not require a login; Radius authentication attributes the report to your account so the developers can follow up. If an upload fails, Pi offers to export the zip.
