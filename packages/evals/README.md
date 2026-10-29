# Pi evals

Behavioral evals for Pi's coding agent, built with `vitest-evals`.

## File conventions

Eval definitions are flat under `evals/`:

- `*.docs.eval.ts` is a documentation-lift eval. `eval:docs` runs each case in isolated `without_docs` and `with_docs` containers and reports lift.
- Other `*.eval.ts` files are host evals. `eval:host` runs the smoke suite; `eval:audit` runs the documentation audit; `eval:edit` runs the edit-format benchmark. They are ordinary vitest-evals suites, not paired comparisons.

Runner code lives in `src/`:

- `cli.ts` orchestrates a comparison
- `docker.ts` builds the two images, discovers cases, and runs one isolated arm
- `plan.ts` expands cases into `(case, variant, repetition)` tasks
- `report.ts` reads Vitest JSON, pairs arms, and computes lift
- `harness.ts` is the vitest-evals adapter
- `edit-format.ts` loads, samples, and grades the edit-format tasks; `edit-format-report.ts` summarizes their results

Eval suites and their fixtures live under `evals/`. Image build files live in `docker/`.

## Run evals

The host smoke eval, on-demand documentation audit, and documentation-lift evals need `PI_PROVIDER` and `PI_MODEL`.

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol npm run eval -w packages/evals
```

That runs the host smoke eval, then the documentation comparison. The documentation audit remains explicit because it scans every documentation page. Extra CLI flags after `--` go to `eval:docs` only.

Host smoke only:

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol npm run eval:host -w packages/evals
```

Documentation audit:

```bash
PI_PROVIDER=openai-codex PI_MODEL=gpt-5.6-sol \
  npm run eval:audit -w packages/evals
```

## Run the edit-format benchmark

`edit-format.eval.ts` measures how reliably a model applies exact edits with each `editMode`. Each task is a TypeScript file with injected bugs and a prompt naming the exact changes, from oh-my-pi's benchmark (see `evals/edit-format/NOTICE.md`); the agent gets `read`, `edit`, and `write`, and a task passes when the file equals the original afterwards.

```bash
PI_PROVIDER=anthropic PI_MODEL=claude-sonnet-5-5 PI_EVAL_EDIT_FORMAT=hashline \
  npm run eval:edit -w packages/evals
npm run eval:edit:report -w packages/evals
```

`PI_EVAL_EDIT_FORMAT` is `replace` (default), `hashline`, or `apply_patch`, which gives the agent `read` and `apply_patch` instead of `edit` and `write`. `PI_EVAL_EDIT_TASKS` (default 30, at most 106) sets how many tasks run, picked evenly across mutation categories, so every model and format gets the same sample. Each run appends one line per task to `.eval/edit-format/results.jsonl`, including failed runs; the report counts the latest run of each task and prints exact and whitespace-normalized pass rates, edit calls, failed edits, how often `write` replaced the edit, and tokens per model and format. These runs call the selected model and spend tokens or subscription quota.

## Run documentation comparisons

From the repository root:

```bash
npm run eval:docs -w packages/evals -- \
  --provider openai-codex \
  --model gpt-5.6-sol
```

`PI_PROVIDER` and `PI_MODEL` provide the same defaults. Both values are required.

The default is one run per variant. Increase repetitions explicitly when measuring stability:

```bash
npm run eval:docs -w packages/evals -- \
  evals/extensions.docs.eval.ts \
  --runs-per-variant 5
```

`PI_EVAL_RUNS_PER_VARIANT=5` is equivalent. Vitest filters are applied during discovery:

```bash
npm run eval:docs -w packages/evals -- -t "adds the model"
```

The runner:

1. Mounts the repository ephemerally for a Docker build, packs the current workspace packages using the repository's consumer-install machinery, then creates separate `without_docs` and `with_docs` images from the staged runtime.
2. Discovers the selected cases in both images and requires identical cohorts.
3. Plans every `(case, variant, model, runNumber)` arm before execution.
4. Runs each arm in a fresh container. A failed or missing arm is recorded and the planned cohort continues.
5. Reads native Vitest JSON through `@vitest-evals/core/node` when a report exists.
6. Pairs exact arms and writes the comparison report. Blocked pairs withhold headline lift; the process exits nonzero.

Repetition order alternates by run number to reduce order bias.

## Documentation variants

`without_docs` omits the coding-agent `README.md`, `CHANGELOG.md`, `docs/`, and `examples/`, then removes the Pi documentation-routing section from the default system prompt.

`with_docs` includes those files and uses the unchanged default prompt.

Both variants install the same local workspace tarballs. Existing npm overrides ensure coding-agent's internal Pi dependencies also come from the current repository rather than the registry. Documentation and source files from internal dependency packages are removed symmetrically so they cannot act as alternate instructions. Startup validates the image allowlist and verifies that the installed coding-agent package resolves from `dist/`. Eval definitions, evaluator helpers, fixtures, and Vitest configuration are root-owned and unreadable after the harness permanently drops to an unprivileged UID. Each run receives a new home, agent directory, workspace, session directory, and container filesystem.

Documentation evals allow only `read`, `write`, `edit`, `grep`, `find`, and `ls` by default. They do not expose shell or web-search tools. Provider traffic still requires container network access, so Docker alone cannot prove that arbitrary code written by an agent never uses the network.

## Results

Each invocation creates an ignored `.eval/<timestamp>_<id>/` directory containing:

- `protocol.json`: model, image IDs, cases, tasks, and protocol digest.
- `expected-runs.json`: the complete planned cohort.
- `observations.jsonl`: normalized outcomes and telemetry.
- `tasks/*/vitest.json`: native JSON for each isolated arm.
- `<variant>/sessions/*/session.jsonl`: native Pi sessions.
- `report.json` and `report.txt`: paired comparisons.

A pair contributes to pass-rate lift only when both arms produce exactly one score. Missing, duplicate, skipped, pending, unscored, or errored arms block the pair. If any pair in an eval set is blocked, headline pass rates are withheld. Missing telemetry remains unavailable rather than being treated as zero.

The report flags no lift, negative deltas, saturated controls or treatments, and observed flakiness. One repetition cannot establish stability.

Artifacts may contain prompts, responses, generated code, and tool output.

## Write an eval

Use one ordinary `describeEval(...)` suite and one explicit `run(...)` call per case:

```ts
import { describeEval, StructuredOutputJudge } from "vitest-evals";
import { createPiDocumentationEvalHarness } from "../src/harness.ts";

const harness = createPiDocumentationEvalHarness();
const judge = StructuredOutputJudge({ expected: { ok: true }, match: "strict", allowExtras: false });

describeEval("Target workflow", { harness, judges: [judge], judgeThreshold: null }, (it) => {
  it("completes the task", async ({ run }) => {
    await run("Complete the target task.");
  });
});
```

The outer runner owns variants, repetitions, isolation, identity, persistence, and reporting. Eval files should contain only scenario setup, the model task, and deterministic grading.

Use `judgeThreshold: null` for comparative scoring. A low score is data, not an infrastructure failure. Reserve Vitest assertions for broken suite invariants.
