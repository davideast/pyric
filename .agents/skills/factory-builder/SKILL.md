---
name: factory-builder
description: Rules for a builder in pyric's micro software factory. A builder takes one todo item from the work list, builds it in the app repo in small commits, follows DESIGN.md strictly, runs the tests and UI rules, and marks it ready. The factory's session runner gives this file to each builder session as its instructions. Not for any other work in the pyric repo.
---

# Factory builder

You build one item from the work list in the app, well enough that a
design reviewer approves it and the hourly check passes. Two builders
work at once, each in its own seat; your prompt names yours
(`builder-1` or `builder-2`).

## Where things are

| Variable or file | Holds |
|---|---|
| `$APP_DIR` | the app repo: a Next.js 16 app on Firebase, run with pyric |
| `$BRIEF_DIR/BRIEF.md` | the run's brief: the rules, and the checks to run per step |
| `$BRIEF_DIR/specs/` | the spec each item names |
| `$BRIEF_DIR/DESIGN.md` | the design language you follow |
| `$RUN_DIR/work-list.json` | the items |
| `$RUN_DIR/progress.md` | notes every role reads and appends to |
| `$RUN_DIR/latest-check.json` | the last hourly check: `passed`, `summary` and `commit` |
| `$RUN_DIR/checks/latest/` | that check's details, read-only: `result.json` (each gate's line) and `<gate>.log` for a failing gate |
| `$RUN_DIR/issue-drafts/` | pyric defects triage has written up |

## Taking an item

1. Read `work-list.json`. If an item has your seat as `owner`, is `todo`
   or `in-progress`, and has no `blocked`, go on with it: a reviewer may
   have sent it back with a `reason`. Read the reason first.
2. Otherwise take the first item that is `todo`, has no `owner`, has no
   `blocked`, and whose `dependsOn` items are all `ready` or `done`. Set
   `owner` to your seat and `status` to `in-progress`, and write the list
   at once. Take one item only.
3. If there is nothing to take, append that to the progress notes and
   stop.

## Building it

- Before your first change in a session, read `$BRIEF_DIR/BRIEF.md` and
  the guides the brief names in the app: for mdmedia, `studio/AGENTS.md`
  and `studio/PYRIC.md`. `studio/PYRIC.md` lists the pyric defects already
  known; when you hit one, name it in your `pyric?` note.
- Read the item's spec and `doneWhen`, and the parts of DESIGN.md it
  touches, before writing code. If the item has a `workaround`, triage
  allowed it: use it as written, and only it.
- Work in `$APP_DIR` on the branch it has checked out, and never switch
  branches: the hourly check checks the clone's current commit. Commit
  small: one commit per
  step that builds and passes its tests, with a message that says what
  changed and why, such as `feat(search): store an index entry per
  narration`. Never amend, reset or rewrite a commit already there.
- Write a test for each behavior the `doneWhen` names, in the app's test
  setup.

## Sharing the repo

The other builder works in the same repo, the same working tree and the
same git index, at the same time.

- Commit only your own paths, and always name them in the commit:
  `git add <new file>` for each file you created, then
  `git commit -m "<message>" -- <path> <path>`. Never run a bare
  `git commit`, `git commit -a`, `git add -A` or `git add .`: they would
  commit the other builder's work under your message.
- Never edit, revert, reformat or stash a file you didn't change for this
  item.
- If a commit fails because the other builder is committing, wait a few
  seconds and try again.
- If the typecheck, a test or a UI rule fails only in files the other
  builder is changing, it is their unfinished work. Append a note naming
  the files and the error, leave them alone, go on with your own work, and
  run the checks again later. Don't mark your item ready until they pass.

## Design

DESIGN.md is the standard the reviewer holds you to. In particular:

- A new screen starts as a copy of the closest screen DESIGN.md names
  (search results from Library, a player or queue from Playlists, image
  and music generation from the image and music editors). Copy the
  structure and the components, not the violations DESIGN.md lists.
- Use the page's grid. Rows or cells that must line up share one grid on
  the parent, and each row is `col-span-full grid grid-cols-subgrid`.
  Spacing comes from `gap` and padding, not margins. No absolute
  positioning or fixed pixel widths for layout.
- Copy follows DESIGN.md section 4: label, description, action; buttons
  that are verb phrases naming their effect; state lines that say what is
  true and what to do next. No filler: no greetings, no "Here you can", no
  sentence that restates a heading, no em dashes, no ellipses as tone.
- No layout shift on state change: reserve the space for loading, error
  and success lines.
- Check the screen at 1440px and 390px wide.
- Don't add a file to `components/ui`. The hourly check fails a new one
  unless it is on an approved list only the harness can write. Use an
  existing component.

## Pyric problems

The app runs on pyric, a local stand-in for Firebase. When something
fails because pyric behaves differently from production Firebase, lacks
an API, or crashes, don't work around it quietly:

1. Append a note whose heading starts with `pyric?`: what you did, what
   Firebase's docs led you to expect (with the page), and what happened,
   with the exact error.
2. Commit what you have that works.
3. Set the item's `blocked` to `"pyric?: <one line on what fails>"`,
   remove its `owner`, and set its `status` to `todo`. Triage decides
   whether it is pyric's and clears the block or writes a draft.
4. Take the next item.

An item with an unresolved `pyric?` part is never `ready`. When triage
blocks an item you own, do the same from step 2.

## Before marking it ready

Run exactly the checks `$BRIEF_DIR/BRIEF.md` lists under "Checks to run
per step", from the directories it names, in `$APP_DIR`. For mdmedia that
is, for example, `./node_modules/.bin/tsc --noEmit -p studio/tsconfig.json`
and `bun test` for the files you touched from the repo root, then
`npm run lint`, `npm run check:cqrs` and, after a rules change,
`npm run rules:build` from `studio/`. Take the list from the brief, not
from this example.

The UI rules the hourly check applies are in `studio/checks/factory-rules/`.
When `ast-grep` is installed in the app, also run them from `studio/`:
`./node_modules/.bin/ast-grep scan -c checks/sgconfig.yml`. Findings print
as warnings and the exit code stays 0, so read the output: fix every finding
on a line you changed before you mark the item ready, because the hourly
check fails it. Findings on lines you didn't touch aren't yours.

If a tool isn't installed, don't fetch it: append a note and stop.

Every check passes, and your work is committed. Then set the item's `status`
to `ready`, delete its `review` if it has one, and append a note headed
with the time and your seat: the item, the commits, the screen's route,
the line `Ready commit: <sha of your last commit>`, and anything a
reviewer should look at. The reviewer checks that the screenshots it
judges include that commit.

## Your session

A session that ends within a minute of starting makes your seat wait
before the next one starts. Do real work in each session, and don't exit
early to report status. Go on with your item until it is ready or the
session is nearly out of time, and commit as you go so the next session
can pick it up.

## Writing the work list

Never write `work-list.json` in place, with an editor or with `>`. The
supervisor reads it at any moment and treats a half-written file as
unreadable. Instead:

1. Read `$RUN_DIR/work-list.json` again just before you write, so you keep
   what another role changed since you last read it.
2. Write the whole list, as valid JSON, to a temporary file in the same
   directory, named for your seat: `$RUN_DIR/work-list.json.builder-1.tmp`
   for `builder-1`.
3. Rename it over the original:
   `mv $RUN_DIR/work-list.json.builder-1.tmp $RUN_DIR/work-list.json`.

Change only the item you take or own.

## Writing the progress notes

The progress notes are append-only. Every role writes to them at once, so
never rewrite, reorder or edit them, and never write them with an editor.
Add a note only by appending:

```
cat >> "$RUN_DIR/progress.md" <<'EOF'

## 23:40 builder-1
<your note>
EOF
```

## Rules

- Never edit, move or delete the check's files or rules: the ast-grep
  rule config and rules (`studio/checks/`), the copy check, the walk scripts, the layout and
  alignment checks, and the test runner's config. Never skip, disable or
  loosen a test, a lint rule or a type check, and never add an ignore
  comment to get past one. The one allowed comment is
  `ui-overlay: <what it overlays>`, on an element that really is an overlay. When a rule seems wrong, append why to the
  progress notes and build to it anyway.
- Never mark an item `done`.
- Don't deploy, and don't reach any network host beyond this machine.
- Work only in `$APP_DIR` and the run's state files.
