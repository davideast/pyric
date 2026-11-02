---
name: factory-triage
description: Rules for triage in pyric's micro software factory. Triage sorts the latest findings into app bugs and pyric defects, turns app bugs into work items, writes each pyric defect as an issue draft in pyric's issue standard with a minimal repro, and marks reviewed items done. It files nothing on GitHub. The factory's session runner gives this file to the triage session as its instructions. Not for any other work in the pyric repo.
---

# Factory triage

The app runs on pyric, a local stand-in for Firebase. When something
breaks, it is either the app's bug or pyric's. The factory exists partly
to find pyric's: each one you write up well is a fix that helps every
app. A pyric defect a builder quietly works around is lost, so you make
sure none is.

## Where things are

| Variable or file | Holds |
|---|---|
| `$RUN_DIR/progress.md` | findings from the user agent, notes from builders (headings starting `pyric?`) |
| `$RUN_DIR/latest-check.json` | the last hourly check |
| `$RUN_DIR/work-list.json` | the items |
| `$RUN_DIR/issue-drafts/` | the drafts you write, one `<slug>.md` each |
| `$RUN_DIR/issue-drafts/repros/<slug>/` | each draft's repro |
| `$APP_DIR` | the app; read it, don't change it |

Your prompt names the run. Use the run directory's name as `<run>` below.

## Sorting a finding

For each finding, `pyric?` note and check failure since your last session:

- **App bug**: the app's code contradicts Firebase's documented API or the
  spec, or the failure goes away when the app does what Firebase's docs
  say. Add a `todo` item for it, first in the list, with the finding's
  steps in its `doneWhen`, unless an item for it already exists.
- **Pyric defect**: the app does what Firebase's docs say, and pyric
  answers differently from production Firebase, lacks the API, crashes,
  or gives an error that doesn't say what failed. Write a draft (below).
- **Can't tell**: write down why in the progress notes, and treat it as a
  pyric defect until a repro says otherwise.

Production evidence is a Firebase or Google Cloud reference page, or the
`firebase` package's own code in `$APP_DIR/node_modules/firebase`. Never
call production Firebase to find out, and never use a real credential.

## A pyric defect

1. Shrink it to a minimal repro: a single `node` script in
   `$RUN_DIR/issue-drafts/repros/<slug>/repro.mjs` that uses the same pyric
   packages as the app (import them from `$APP_DIR/node_modules`), does
   the one thing that fails, and exits 1 when pyric misbehaves and 0 when
   it behaves as production does. Run it, and keep its output beside it as
   `output.txt`. When only the browser shows it, write the steps as a
   Playwright script instead, the same way.
2. Write the draft (format below) to `$RUN_DIR/issue-drafts/<slug>.md`.
   The slug is short, lowercase words joined by hyphens. When a draft for
   the same behavior exists, add to it instead.
3. Mark the work item it blocks: set `"pyricIssue": "<slug>.md"` and, if
   the item can't go on, `"blocked": "<slug>.md"`.
4. A workaround is allowed only when the draft records it under
   **Workaround** (for a missing API) or in the **Done when** of a
   divergence or bug ("Done when: ..., and the app drops its workaround in
   <file>"). Write in the progress notes that the builder may use it.

Check every draft with:

```
bun test/builders/harness.ts factory-drafts --run-dir $RUN_DIR
```

from a pyric checkout when there is one. Fix each draft it marks invalid.

## The draft

Each draft is one kind from pyric's issue standard. The first two lines
are the title and its one label; then the kind's four bold fields, one or
two lines each; then the "Found by" line.

A behavior that differs from production:

```
Title: <Service>: pyric <does X>, production <does Y>
Label: divergence

**pyric:** <what pyric does, with the exact error>

**Production:** <what production does>. [Reference](<Firebase doc URL>)

**Who notices:** <who hits it and how>

**Done when:** <a scenario under test/apps/ that shows the two agree>

Found by factory run <run>, item <item id>. Repro: `issue-drafts/repros/<slug>/repro.mjs`.
```

An API pyric lacks:

```
Title: Support <API> in <package>
Label: support

**Missing:** <what fails under pyric, with the exact error>

**In production:** <what the API does>. [Reference](<Firebase doc URL>)

**Workaround:** <what the app does today, or none>

**Done when:** <the implementation, and the scenario under test/apps/ that checks it>

Found by factory run <run>, item <item id>. Repro: `issue-drafts/repros/<slug>/repro.mjs`.
```

A crash or unclear error in pyric's own tooling (the CLI, the dev server,
the Next.js plugin):

```
Title: <What breaks> when <condition>
Label: bug

**What breaks:** <what the developer hits, with the exact error>

**Expected:** <what should happen>

**Repro:** `issue-drafts/repros/<slug>/repro.mjs`: <one line on what it does>

**Done when:** <the scenario under test/apps/ to add or extend>

Found by factory run <run>, item <item id>.
```

## Marking items done

An item is `done` when all of these hold: its `review.design` is
`approved`, the user agent wrote that it works end to end and has no open
finding against it, and the latest check passed. Set its `status` to
`done`. Leave every other item's status as it is.

## Your session

A session that ends within a minute of starting makes your seat wait
before the next one starts. Do real work in each session, and don't exit
early to report status. Sort every new finding, and write and run each
repro, before you stop.

## Writing the work list

Never write `work-list.json` in place, with an editor or with `>`. The
supervisor reads it at any moment and treats a half-written file as
unreadable. Instead:

1. Read `$RUN_DIR/work-list.json` again just before you write, so you keep
   what another role changed since you last read it.
2. Write the whole list, as valid JSON, to a temporary file in the same
   directory: `$RUN_DIR/work-list.json.triage.tmp`.
3. Rename it over the original:
   `mv $RUN_DIR/work-list.json.triage.tmp $RUN_DIR/work-list.json`.

## Rules

- File nothing. Never run `gh`, and never write to GitHub or any other
  remote. The coordinator reviews the drafts in the morning.
- Never edit the app, the check or the specs, and never fix pyric.
- Write a short note in the progress notes each session under a heading
  with the time and `triage`: each finding, its verdict, and the item or
  draft it became.
