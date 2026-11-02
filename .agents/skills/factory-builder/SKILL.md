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
| `$BRIEF_DIR/specs/` | the spec each item names |
| `$BRIEF_DIR/DESIGN.md` | the design language you follow |
| `$RUN_DIR/work-list.json` | the items |
| `$RUN_DIR/progress.md` | notes every role reads and adds to |
| `$RUN_DIR/latest-check.json` | the last hourly check |
| `$RUN_DIR/issue-drafts/` | pyric defects triage has written up |

## Taking an item

1. Read `work-list.json`. If an item has your seat as `owner` and is
   `todo` or `in-progress`, go on with it: a reviewer may have sent it
   back with a `reason`. Read the reason first.
2. Otherwise take the first `todo` item with no `owner` and no `blocked`
   field. Set `owner` to your seat and `status` to `in-progress`, and
   write the file back at once, keeping every other item and field as it
   was. Take one item only.
3. If there is nothing to take, write that in the progress notes and stop.

## Building it

- Read the item's spec and `doneWhen`, and the parts of DESIGN.md it
  touches, before writing code.
- Work in `$APP_DIR` on its `main` branch. Commit small: one commit per
  step that builds and passes its tests, with a message that says what
  changed and why, such as `feat(search): store an index entry per
  narration`. Never amend, reset or rewrite a commit already there.
- The other builder works in the same repo at the same time. Stage only
  the files you changed (`git add <path>`, never `git add -A` or
  `git add .`), and never revert, reformat or stash files you didn't
  touch. If a commit fails because the other builder is committing, wait
  a few seconds and try again.
- Write a test for each behavior the `doneWhen` names, in the app's test
  setup.

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

## Before marking it ready

Run, from `$APP_DIR`:

1. the typecheck (`npx tsc --noEmit`, or the app's `typecheck` script);
2. the tests for what you changed;
3. the UI rules (`npx ast-grep scan`, with the app's own rule config).

All three pass, and your work is committed. Then set the item's `status`
to `ready`, and add a note to the progress notes under a heading with the
time and your seat: the item, the commits, the screen's route, and
anything a reviewer should look at.

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

## Rules

- Never edit, move or delete the check's files or rules: the ast-grep
  rule config and rules, the copy check, the walk scripts, the layout and
  alignment checks, and the test runner's config. Never skip, disable or
  loosen a test, a lint rule or a type check, and never add an ignore
  comment to get past one. When a rule seems wrong, write why in the
  progress notes and build to it anyway.
- Never mark an item `done`, and never change an item you don't own,
  except to take it.
- When something fails because pyric (the local Firebase the app runs on)
  behaves differently from production Firebase, or crashes, don't work
  around it quietly. Write in the progress notes what you did, what you
  expected from Firebase's docs, and what happened, with the exact error,
  under a heading that starts with `pyric?`. Then stop work on that part
  and go on with the rest of the item. Triage decides whether it is
  pyric's; a workaround is allowed only once triage records it in an
  issue draft.
- Don't deploy, and don't reach any network host beyond this machine.
- Work only in `$APP_DIR` and the run's state files.
