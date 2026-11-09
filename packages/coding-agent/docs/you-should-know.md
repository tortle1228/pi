# You Should Know

The built-in `you-should-know` extension is a side agent modeled on Claude Code's "You should know" plugin. While the main agent works, it checks the session and flags at most one thing you would likely miss but should know, such as a decision with a cost or a result that may be off.

It is off by default because each check is one extra model request. Run `/you-should-know` to toggle it for the current session, or set `"youShouldKnow": true` in [settings](settings.md#interaction) to keep it on.

## Behavior

**When it checks.** After every sixth step (one model response and its tool calls) of a run. It skips the check while a note is showing or another check is running. The check runs in the background and never delays the main agent.

**How it checks.** It sends the main session's system prompt, messages and active tools to the current model, followed by an observer prompt, so the request can reuse the main session's prompt cache. The answer is either nothing or one note: a one-line summary, a tag (`Heads up` for this session's work, `You should know` for a concept that matters), and a short explanation, written in your language.

**The note.** It appears above the editor with three buttons, clickable in fullscreen mode:

- **Explain** shows the explanation.
- **Chat in main session** puts the note into an empty prompt box so you can ask about it.
- **Dismiss** closes it.

`/you-should-know explain`, `/you-should-know chat` and `/you-should-know dismiss` do the same from the keyboard. A note closes by itself after you send two prompts.

**Backoff.** Dismissing or ignoring notes three or more times in a row skips the next 1, 2, 4, up to 16 checks. Explain or Chat resets the count. The last 50 notes are never shown again. This state resets when the session ends.

To remove the extension entirely, add `-builtin:you-should-know` to `extensions` in [settings](settings.md#resources).
