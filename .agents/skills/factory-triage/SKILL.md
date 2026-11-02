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
| `$RUN_DIR/progress.md` | findings from the user agent (`### finding <id>`), notes from builders (headings starting `pyric?`); append-only |
| `$RUN_DIR/latest-check.json` | the last hourly check |
| `$RUN_DIR/work-list.json` | the items |
| `$RUN_DIR/issue-drafts/` | the drafts you write, one `<slug>.md` each |
| `$RUN_DIR/issue-drafts/repros/<slug>/` | each draft's repro |
| `$APP_DIR` | the app; read it, don't change it |

Your prompt names the run. Use the run directory's name as `<run>` below.

## Sorting what came in

Each session, sort every open user-agent finding, every item a builder
blocked with `"pyric?: ..."`, and every check failure since your last
session:

- **App bug**: the app's code contradicts Firebase's documented API or the
  spec, or the failure goes away when the app does what Firebase's docs
  say. Add a fix item first in the list, unless one exists. A blocked
  item that turns out to be an app bug: delete its `blocked`, and add the
  cause to its `doneWhen`.
- **Pyric defect**: the app does what Firebase's docs say, and pyric
  answers differently from production Firebase, lacks the API, crashes,
  or gives an error that doesn't say what failed. Write a draft (below).
- **Can't tell**: append why to the progress notes, and treat it as a
  pyric defect until a repro says otherwise.
- **Not a bug**: the finding misread the spec, or no longer shows. Close
  it as resolved.

A fix item has the lead's shape (see factory-lead): an `id` of lowercase
words joined by hyphens, a `title`, `status` `todo`, the `spec` it comes
from, a `doneWhen` that holds the finding's steps and expected result,
and `"finding": "<finding id>"` when it came from a finding.

### Closing findings

A user-agent finding is open until you or the lead close it. Close each
one you sort, in the same session, in one of two ways:

- make an item for it (a fix item with its `finding` id, or a blocked
  item with a draft), or
- append `Closed finding <id>: resolved, <why>` to the progress notes.

Append `Closed finding <id>: item <item id>` for the first way too, so
anyone reading the notes sees each finding closed. The fix item now
carries the finding, so the item the finding was raised against can be
marked done without it.

### Production evidence

Production evidence is a Firebase or Google Cloud reference page, or the
`firebase` package's own code in `$APP_DIR/node_modules/firebase`. Never
call production Firebase to find out, and never use a real credential.
A divergence's **Production** field and a missing API's **In
production** field each carry a link to that evidence; `factory-drafts`
refuses a draft without one.

## A pyric defect

1. Shrink it to a minimal repro: a single `node` script in
   `$RUN_DIR/issue-drafts/repros/<slug>/repro.mjs` that uses the app's
   installed pyric and firebase packages (below), does the one thing that
   fails, and exits 1 when pyric misbehaves and 0 when it behaves as
   production does. Run it as
   `node "$RUN_DIR/issue-drafts/repros/<slug>/repro.mjs" > "$RUN_DIR/issue-drafts/repros/<slug>/output.txt" 2>&1; echo "exit $?" >> "$RUN_DIR/issue-drafts/repros/<slug>/output.txt"`.
   A repro you haven't run, or that fails for another reason, is not a
   repro. When only the browser shows it, write the steps as a Playwright
   script instead, run the same way.
2. Write the draft (format below) to `$RUN_DIR/issue-drafts/<slug>.md`.
   The slug is short, lowercase words joined by hyphens. When a draft for
   the same behavior exists, add to it instead.
3. Mark the work item it affects: set `"pyricIssue": "<slug>.md"`. If the
   item can't go on, set `"blocked": "<slug>.md"`, remove its `owner` and
   set its status to `todo`. Only you set a block to a draft.
4. A workaround is allowed only when the draft records it under
   **Workaround** (for a missing API) or in the **Done when** of a
   divergence or bug ("Done when: ..., and the app drops its workaround in
   <file>"). Then delete the item's `blocked`, set its `workaround` to one
   line on what the builder may do, and append that to the progress
   notes.

### Loading the app's packages in a repro

The script lives outside the app, so a bare `import 'pyric/firestore'`
doesn't resolve, and `createRequire(...).resolve` fails on pyric, whose
packages export only an `import` entry. Start each repro with this loader,
which imports a package from the app's own `node_modules` (the app package
is `$APP_DIR/studio`; the loader also finds packages hoisted to
`$APP_DIR/node_modules`):

```js
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const appPackage = join(process.env.APP_DIR, 'studio');

function packageDir(name) {
  for (let dir = appPackage; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === dirname(dir)) throw new Error(`${name} is not installed under ${appPackage}`);
  }
}

function entryFile(entry) {
  if (typeof entry === 'string') return entry;
  for (const key of ['node', 'import', 'default']) if (entry?.[key]) return entryFile(entry[key]);
  throw new Error('no import entry');
}

async function load(specifier) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = `.${specifier.slice(name.length)}`;
  const dir = packageDir(name);
  const { exports, main } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = exports === undefined ? (main ?? 'index.js') : entryFile(typeof exports === 'string' ? exports : exports[subpath]);
  return import(pathToFileURL(join(dir, file)).href);
}

const { initializeApp } = await load('pyric/app');
const { getFirestore } = await load('pyric/firestore');
```

Load the same entry points the app imports; read the app's code to see
which. If the app reaches pyric through a register hook or a plugin
rather than direct imports, say so in the draft and reproduce through
that path instead.

### Recording the repro in the draft

The draft names the exact command you ran and what it printed, as the
templates below show: the command and its exit code in the **Repro**
field of a bug or the "Found by" line of the other kinds, then an
`Output:` block after the "Found by" line with the lines of `output.txt`
that show the failure, each indented by four spaces.

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

Found by factory run <run>, item <item id>. Repro: `node "$RUN_DIR/issue-drafts/repros/<slug>/repro.mjs"`, exit 1.

Output:
    <the lines of output.txt that show the failure>
```

An API pyric lacks:

```
Title: Support <API> in <package>
Label: support

**Missing:** <what fails under pyric, with the exact error>

**In production:** <what the API does>. [Reference](<Firebase doc URL>)

**Workaround:** <what the app does today, or none>

**Done when:** <the implementation, and the scenario under test/apps/ that checks it>

Found by factory run <run>, item <item id>. Repro: `node "$RUN_DIR/issue-drafts/repros/<slug>/repro.mjs"`, exit 1.

Output:
    <the lines of output.txt that show the failure>
```

A crash or unclear error in pyric's own tooling (the CLI, the dev server,
the Next.js plugin):

```
Title: <What breaks> when <condition>
Label: bug

**What breaks:** <what the developer hits, with the exact error>

**Expected:** <what should happen>

**Repro:** `node "$RUN_DIR/issue-drafts/repros/<slug>/repro.mjs"` exits 1: <one line on what it does>

**Done when:** <the scenario under test/apps/ to add or extend>

Found by factory run <run>, item <item id>.

Output:
    <the lines of output.txt that show the failure>
```

## Marking items done

An item is `done` when all of these hold:

- it is `ready` and its `review.design` is `approved`;
- the user agent appended `<item id>: works end to end` after its ready
  note, and every finding against it is closed;
- the latest check passed.

Set its `status` to `done`. Leave every other item's status as it is.

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

## Writing the progress notes

The progress notes are append-only. Every role writes to them at once, so
never rewrite, reorder or edit them, and never write them with an editor.
Add a note only by appending:

```
cat >> "$RUN_DIR/progress.md" <<'EOF'

## 23:40 triage
<your note>
EOF
```

## Rules

- File nothing. Never run `gh`, and never write to GitHub or any other
  remote. The coordinator reviews the drafts in the morning.
- Never edit the app, the check or the specs, and never fix pyric.
- Append a short note to the progress notes each session: each finding
  and block, its verdict, and the item or draft it became.
