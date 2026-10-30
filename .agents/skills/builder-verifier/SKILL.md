---
name: builder-verifier
description: Verify one run of pyric's app-builder pilot - check the run is valid, reproduce each reported problem and Google-host event with `bun test/builders/harness.ts reproduce`, classify what reproduces, shrink it to an app scenario, dedupe against GitHub issues, and stage issue drafts for David. Use when asked to verify, judge or triage builder runs or a builder round. Not for writing briefs (builder-brief-writer) or for building apps (app-builder).
---

# Builder verifier

A builder's report is a lead, not a finding. You confirm only what
reproduces, on the same tarballs, in the same sandbox, and stage only what
production evidence backs. Most reports end unconfirmed, a builder's own
bug, or a duplicate; that is the expected result, not a failure.

## Never

- **File nothing.** In round 1 every confirmed finding is a draft David
  reviews (decision D3). Never run `gh issue create`, `gh api -X POST` or
  any other write to GitHub.
- Never call production, and never give a repro script a credential or a
  model. `reproduce` gives it no model channel and no network beyond
  loopback.
- No branches, worktrees, commits, pull requests or deletes. Write only
  under the round's data directory.

## Where a run is

`<data root>/runs/<round>/<run>/`, where the data root is
`/home/david/pyric-ops/assurance/builders` (or `PYRIC_BUILDERS_DATA_DIR`):

- `report.json`: `{ builder, harness }`. `builder` is the builder's own
  report (null when it wrote none that holds the shape). `harness` is what
  the builder couldn't edit: the brief, the commit and tarball hashes, how
  the run ended, `automaticProblems` (allowed refusals, Google hosts),
  `missingRefusals`, `tokenFoundIn`, usage.
- `brief.json`, `network.jsonl`, `logs/`, and `app.tgz` (the app without
  `node_modules`).

## For each run, in order

### 1. Is the run valid?

The run is **invalid**, and nothing from it is staged, when it broke a
builder rule (`.agents/skills/app-builder/SKILL.md`):

- the report or the logs cite pyric source: repo paths such as
  `packages/<name>/src/`, or code inside `node_modules/@pyric/*` or
  `node_modules/pyric*` beyond their READMEs;
- it used a credential other than the fake config, or
  `harness.tokenFoundIn` is not empty;
- it launched a browser of its own instead of the harness browser.

An invalid run still gets a `verdict.json`; every problem of it counts as
`invalid`.

### 2. Reproduce

List what the run reported:

```
bun test/builders/harness.ts reproduce <round> <run> --list
```

Each line is a selector: a builder problem's id, `refusal-allowed-<n>`, or
`google-host:<host>`. For each, write a repro script in
`<data root>/runs/<round>/<run>/verifier/<selector slug>.mjs` (never inside
the repo) and run it:

```
bun test/builders/harness.ts reproduce <round> <run> <selector> \
  --script <script.mjs> [--expect '<error text>'] [--register] [--minutes <n>]
```

The harness extracts a fresh copy of the builder's app, pins it to the
run's tarballs (it refuses if the tarballs in `dist/packages`, or
`--packages <dir>`, are not the ones the run installed), installs it in a
new sandbox, copies your script in beside `package.json` as
`pyric-repro.mjs`, and runs `node pyric-repro.mjs` there under the
recorder, with the harness browser at `PYRIC_BUILDER_BROWSER_WS`. It tries
twice at most and stops at the first reproduction.

The script's contract:

- **exit 1 when the problem shows**: pyric did what the report says;
- **exit 0 when pyric behaves as production does**;
- anything else (a crash, a timeout) is inconclusive, never a reproduction.

Pass `--expect` with the error text the report gives, so a script that
fails for another reason doesn't count. Pass `--register` to run it as
`node --import @pyric/cli/register`, for a Node host path. A script can
start the app's dev server with `node:child_process` and drive the page
through the harness browser with the Playwright client the harness names:
`const { chromium } = await import(process.env.PYRIC_BUILDER_PLAYWRIGHT)`, then
`chromium.connect(process.env.PYRIC_BUILDER_BROWSER_WS)`.
`test/builders/fixtures/repros/` has an example of each kind.

A `google-host:` problem is judged by the network record alone: it
reproduces when the try reaches for that host again, whatever the script
exits with. Write the script to repeat the step the run's logs show.

The command exits 0 when it reproduced, 1 when unconfirmed, and keeps
`repro.json`, the script and each try's network record and logs in
`runs/<round>/<run>/repros/<slug>/<stamp>/`. Read `repro.json` for each
try's outcome and reason. Unconfirmed after both tries: the problem is
`unconfirmed` and is not staged. You may revise a script and run it again
when the script was wrong; say so in the verdict.

### 3. Classify what reproduced

- **Builder's own bug**: the app contradicts pyric's docs or Firebase's
  API. Dropped.
- **Pyric differs from production**: needs production evidence that makes
  no production call: a Firebase doc, a committed observation in
  `packages/conformance/observations/`, or the `firebase` SDK's source.
  Belief alone is **needs capture**: listed for the oracle queue, not staged.
- **Misleading docs**: the page, the sentence, and what pyric does.
- **Unclear pyric error**: the exact error text and what the user needed
  to know.

### 4. Shrink

Cut the reproduction to the smallest one, written as a change to an
existing app scenario under `test/apps/` where one fits, and name that
scenario. Propose a new app only when none fits: every app adds setup time
to every pull request and publish.

### 5. Dedupe

Search open issues and those closed in the last 90 days, through REST
(`gh issue view` is broken on this repo):

```
gh api 'repos/davideast/pyric/issues?state=all&since=<ISO date 90 days ago>&per_page=100' --paginate \
  --jq '.[] | select(.pull_request == null) | "\(.number)\t\(.state)\t\(.title)"'
gh api -X GET search/issues -f q='repo:davideast/pyric is:issue "<error text>"' --jq '.items[] | "\(.number)\t\(.state)\t\(.title)"'
```

A match is a **duplicate**: record its number and stage nothing.

### 6. Stage a draft

For each confirmed finding that is not a duplicate, write
`<data root>/runs/<round>/issue-drafts/<run>--<slug>.md`:

```
Title: <what pyric does wrong, in one line>
Labels: <the lane label of the PRIORITIES.md section it serves>, source:app-builder

## What happens
## Reproduction
<the shrunk reproduction, and the scenario under test/apps/ to extend>
## Production's behavior
<the classification and its evidence: the doc, the observation, or the SDK source>

Found by: <model> builder, run <run>. Verified by: Opus 5.5.
```

The lane labels are `lane:app-check`, `lane:velocity`, `lane:rules`,
`lane:multi-resource`, `lane:reliability`, `lane:node-host`,
`lane:functions`, `lane:demos` and `lane:live-mode`, one per section of
`PRIORITIES.md`. `source:app-builder` is a label only David creates.

## verdict.json

One per run, `<data root>/runs/<round>/<run>/verdict.json`:

```json
{
  "round": "r1",
  "run": "r1-1-haiku-5-5",
  "valid": true,
  "invalidReason": null,
  "problems": [{
    "selector": "p1",
    "verdict": "confirmed | duplicate | needs-capture | unconfirmed | builder-bug | invalid",
    "class": "pyric-differs | misleading-docs | unclear-error | null",
    "evidence": "the doc URL, observation path or SDK source line; null when none",
    "repro": "repros/<slug>/<stamp>/repro.json, or null when not reproduced",
    "duplicateOf": null,
    "scenario": "test/apps/<name>, or null",
    "draft": "issue-drafts/<run>--<slug>.md, or null"
  }],
  "verdicts": {
    "confirmed": { "pyricDiffers": 0, "misleadingDocs": 0, "unclearError": 0 },
    "duplicate": 0, "needsCapture": 0, "unconfirmed": 0, "builderBug": 0, "invalid": 0
  }
}
```

`verdicts` counts the problems by verdict, in the shape of a
`verification` line of `measurements.jsonl` (`test/builders/measurement.ts`).
Every selector `--list` printed gets exactly one entry. Don't write
`measurements.jsonl` yourself: the line also carries your own cost and
tokens, which only the process that started you knows.

When every run of the round is judged, tell David: per run, its verdicts,
and the list of staged drafts for his review.
