# Native grep engine

An in-process engine for the `grep` tool, loaded as a Node-API addon. It searches like `rg --hidden --sort path` (the same files, order, and hits) without starting a ripgrep process per call, and searches files in parallel.

## Build

```bash
npm run build:native-grep   # from packages/coding-agent; needs Rust (https://rustup.rs)
```

The script runs `cargo build --release --locked` here and installs the addon as `native/prebuilds/<platform>-<arch>/pi_grep.node`, where the `grep` tool looks for it (`getNativeGrepAddonPath()` in `src/config.ts`). Without that file, or when it does not load, the tool uses ripgrep. `PI_GREP_ENGINE=rg` forces ripgrep.

Prebuilds are not committed and not published: build the engine on each machine that should use it.

## Contract

`src/lib.rs` exports `search(request, token)` and `CancelToken`. The request and hits follow `GrepEngine` in `src/core/tools/grep-engine.ts`; `src/core/tools/grep-native-engine.ts` adapts them. The engine only finds hits; the tool keeps paging, path display, context lines, and truncation.

Behavior that matches ripgrep and is checked against it by `test/grep-native-engine.test.ts`:

- `.gitignore` applies inside a git repository; `.ignore` and `.rgignore` apply everywhere; hidden files are searched.
- Files are ordered per root, component-wise by path; roots in the order given.
- A walked file is skipped at its first NUL byte; a file named directly is searched with NULs read as line ends, and globs and ignore files do not apply to it.
- `count` counts every match, not every matching line.

One difference: a file that cannot be read yields no hits, where ripgrep fails the whole search.

## Check

```bash
cargo fmt --check && cargo clippy --release
```
