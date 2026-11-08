---
name: upstream-sync
description: Review and port upstream earendil-works/pi commits into this personal fork. Covers range selection, triage, applying patches, verification depth, per-commit commits with Upstream trailers, and updating FORK.md.
---

# Upstream Sync

The fork ledger is [FORK.md](../../FORK.md) (repo root, two directories above this skill). Read it first: it holds the last reviewed upstream SHA, the fork feature list with tests, and the removed subsystems.

## 1. Range

```bash
git fetch --no-tags --no-write-fetch-head https://github.com/earendil-works/pi.git <target-sha>
git log --oneline <last-reviewed-sha>..<target-sha>
```

Find commits already present with `git cherry personal <target-sha>` or `git patch-id`. Both compare diffs, not behavior; confirm by reading the code.

## 2. Triage

Give every commit in the range one status:

- **ported**: applied unchanged (removed-path and CHANGELOG hunks dropped)
- **adapted**: applied with changes to fit the fork
- **already present**: the fork has it or an equivalent
- **not applicable**: touches only removed subsystems or docs
- **deferred**: may matter, not reviewed now; list it in FORK.md with the reason
- **skipped**: decided against; give the reason

Port by default: fixes for bugs a user can hit, in code the fork keeps. Skip or defer: features nobody asked for, refactors, and changes that conflict with fork features. Present the triage to the user before applying.

## 3. Apply

In dependency order, one commit at a time:

```bash
git diff <sha>^ <sha> -- <paths the fork keeps> > /tmp/<sha>.patch
git apply --check /tmp/<sha>.patch && git apply /tmp/<sha>.patch
```

Exclude `*CHANGELOG.md` and every removed path. On conflict, port by hand and mark the commit adapted. A clean apply is not evidence that the change works in the fork.

## 4. Verify

Pick the depth by risk:

| Change | Verification |
|---|---|
| Does not touch fork feature code | Tests the upstream commit added or changed, then `npm run check` |
| Touches fork feature code (FORK.md table) | The above plus that feature's tests; add a fork regression test when the change alters fork behavior |
| Changes generated files (schemas, model catalog, reference docs) | `npm run build`, then confirm the generated output matches the patch |

Before claiming a bug in review, or fixing one, write the test and run it against the code before the fix. If it does not fail there, the bug is not real: withdraw the finding and drop the test.

## 5. Commit

One commit per upstream commit, upstream subject unchanged, with trailers:

```
<upstream subject>

Upstream: <full sha>
Adapted: <one line on what changed>   # only for adapted commits
```

Stage explicit paths. When several ports were applied to the working tree together, split them by applying each patch to the index in order with `git apply --cached /tmp/<sha>.patch` and committing; after the last commit `git diff` must be empty. The pre-commit hook runs `npm run check` against the whole working tree, not the staged split, so intermediate commits are not checked on their own; only the final tree is.

## 6. Record

Update FORK.md: set the last reviewed SHA, add a Sync Log entry (range, counts, skip categories, deferred table), and drop deferred rows that were resolved.
