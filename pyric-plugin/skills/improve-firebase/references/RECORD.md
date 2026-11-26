# Recording proven findings

Record a finding only after Phase 4 has vetted it at E2 or higher. A recording
reruns the finding in an isolated local Pyric sandbox, checks the gates, and
renders a silent 8-slide video plus keyframes. If a gate fails, there is no
video: report the failed gate.

All commands run from the repository that contains `pyric-plugin/`, so
Playwright resolves from the project or from `~/.pyric/video-runtime`. Write
output to a temp directory, never into the target app.

## 1. Preflight

```bash
node pyric-plugin/skills/improve-firebase/scripts/doctor.mjs --json
```

Continue when the report has `"ready": true`. If Playwright or Chromium is
missing, run `doctor.mjs --install --json`. It installs into
`~/.pyric/video-runtime` and never touches the project's `package.json`.

On Linux the capture backend is `x11-xvfb`, with `cdp-surface` as fallback. On
macOS it is `macos-avfoundation`, with the same fallback.

## 2. Pick the variant

Choose by what differs between the before and after recordings.
`scripts/record.mjs` is the single entry point; it picks the variant from the
scenario.

| Variant | What changes | Scenario field | Example |
|---|---|---|---|
| Rules | Same app, different Rules file | `fixRules` (or `--rtdb-rules`, `--firestore-rules`, `--storage-rules`) | An owner check missing from an RTDB `.write` rule |
| Build | Same Rules, different app build | `behavior` | Sign-out revokes credentials before cleanup runs (The fix) |

### Rules variant

The scenario names the app build (`app.dist`), the two actors, the `steps`
that perform the repro, and `fixRules`. The recorder runs the control and
the repro against the current Rules, hot-reloads the fixed Rules, and runs
both again. With no `app`, it records the data plane only.

Key fields:

- `finding.campaign`, `finding.probe`: the probe slug names the output directory.
- `app.dist`: a built static bundle (`app.build` can produce it first). Omit `app` for a data-plane-only recording.
- `rules.rtdb` (or `rules.database`) / `firestore` / `storage`: paths to the baseline Rules when recording standalone or overriding the export. Relative paths in `scenario.json` (`rules.*`, `fixRules.*`, `seedFile`, `app.dist`, `behavior.fixApp.dist`) resolve against the scenario file's directory.
- `seedFile` (or `--seed`): JSON seed file using the multi-service envelope. Accepted top-level envelope keys are `"version"`, `"firestore"`, `"database"`, `"databases"`, `"rtdb"`, `"auth"`, `"users"`, and `"storage"`. Whenever Realtime Database is configured (including dual Firestore and RTDB setups and the build variant), the seed must declare `"database"`, `"databases"` (`{ "<instance>": { ... } }` for multi-instance RTDB), or `"rtdb"` (`"users"` seeds Auth accounts, not an RTDB `/users` path). User paths inside `"database"` or `"databases.<instance>"` (including top-level `/data`) are loaded verbatim without unwrapping; a bare RTDB tree fails Gate G1.
- `actors.owner`, `actors.peer`: `uid`, `name`, `view`, `claims`, and an optional `expect.after` DOM assertion for G4.
- `reproOperation`, `controlOperation`: SDK operations (`service`, `method`, `path`, optional `uid`, optional `instance` for multi-instance RTDB, and `data`) for standalone data-plane scenarios or export overrides. `reproOperation` supplies the probe metadata, target path, and Gate G5 fix replay operation; when `steps` is omitted (or has no `repro` SDK step), `reproOperation` also executes directly during Gate G3, whereas a non-empty `steps` array executes its steps during Gate G3 first. Write operations (`set`, `update`, `push`, `setDoc`, `updateDoc`, `addDoc`) require a non-null `data` payload (`update` and `updateDoc` require a JSON object; use `remove` or `deleteDoc` for deletions).
- `steps`: `ui` actions, `wait-expect`, or `sdk` operations (`service`, `method`, `path`, optional `instance`, `data`; `rateHz` + `frames` for continuous motion).
- `fixRules.rtdb` / `firestore` / `storage`: paths to the fixed Rules; `fixRules.before` / `after`: short snippets for the fix slide.

### From an assurance export

Record straight from a Pyric assurance export (the `firebase_assurance_export`
bundle) with `--campaign <export.json> --probe <id>`, plus a scenario override
for what the export can't know:

```bash
node pyric-plugin/skills/improve-firebase/scripts/record.mjs \
  --campaign /tmp/campaign-export.json --probe bob-overwrites-alice-message \
  --scenario /tmp/override.json --rtdb-rules /tmp/database.fixed.rules.json \
  --out /tmp/pyric-evidence --render --formats mp4 --json
```

*(Note: The chat-overwrite fix used in this example—moving the `.write` rule to `$messageId` and adding a speaker check—is a simplified fix for demonstration. A real fix must keep legitimate writes by others, such as reactions, working. The recorded video only proves the shown write is denied.)*

What the recorder reads from the export:

| Export field | Used for |
|---|---|
| `report.results[]` | The probes. `--probe` matches `probeId` |
| `campaign.id` | `finding.campaign` |
| `report.targetHash` | `finding.targetHash` |
| `results[].mutationSpec.operation` | The repro, run as the peer |
| `results[].actorEvidence.uid` | The peer's uid |
| `observations[]` | The owner's control: an `ALLOW` observation by another actor on the mutated path (or a sibling path), run with that actor's token |
| `campaign.target.rules.rtdb` | The current Rules (the whole `{ "rules": … }` document) |
| `campaign.target.state.rtdb` | The sandbox seed, wrapped automatically in `{ "database": <tree> }` |
| `verifications[]` | Whether assurance confirmed the fix you are recording (see below) |
| `invariant.statement`, `mutationSpec.description`, `probeId` | Default `why`, `repro`, and `title` copy |

The export has no severity, so the default is `UNRATED`. Set `copy.severity`
yourself. The probe's own `control` is the peer's write to their own data,
so it is used only when no observation fits.

The override still supplies:

- `app.dist`, and each actor's `view`, `claims`, and display `name`
- `actors.owner.expect` (the DOM text G4 looks for before and after)
- all the slide `copy`, including `severity`
- `stage`

Scenario values win over the export: `controlOperation` replaces the
observation-derived control, `rules.rtdb` replaces the inline Rules, and
`seedFile` (or `--seed`) replaces the inline state. If a supplied seed or Rules
file differs from what the campaign ran against, the result JSON lists a
`SEED_DIFFERS_FROM_CAMPAIGN` or `RULES_DIFFER_FROM_CAMPAIGN` warning; the run
still proceeds. `inputs` in the result JSON and `evidence.json` records where
the control, Rules, and seed came from.

#### When assurance could not confirm the fix

The sandbox can show a fix denying the repro (G5) even when assurance
`verify` could not prove it, for example an `engine-gap` on an idiomatic
`data`/`newData` rule. The recorder matches the fix you pass to the export's
`verifications[]` by recomputing the target hash with your fix Rules swapped
in. Unless that verification reports `no-counterexample` for the probe, the
bundle carries `fixAssurance: { "verified": false, "reason": … }` in
`evidence.json` and `manifest.json`. Reasons are `engine-gap`,
`counterexample`, `not-verified`, and `no-verification`. The fix slide and the
fix video then show one plain line under the heading, for example "Assurance
could not confirm this fix (engine gap). The sandbox recording shows the write
denied." A verified fix shows nothing extra, and a scenario recorded without an
export carries no `fixAssurance`. The line appears in the `split-actors`
layout only.

### Build variant

The scenario names a before build (`app.dist`) and an after build
(`behavior.fixApp.dist`). Both run under the same Rules and seed. The recorder
captures one continuous session: it reproduces the defect on the before build,
then shows the after build doing the right thing.

`behavior` fields:

| Field | Purpose |
|---|---|
| `fixApp.dist` | The after build |
| `action` | What the actor does. `kind: "sign-out"`, `actor`, `menuItemText`, optional `triggerText` (defaults to the actor's initial) |
| `check` | What proves the defect. `kind: "presence-entry"`, `path`, `uid`, `waitMs` (default 3000) |
| `focusSelectors` | Per-role CSS selector for the spotlight, for example `{ "peer": "[class*=\"pile\"]" }` |
| `pathTemplate` | The data path with variables, for example `/app/rooms/$roomid/presence/$clientId` |
| `pathValues` | The value shown for each variable |
| `pathCallouts` | A `label` and `detail` per variable for the path slide |
| `deck` | `problemFacts` (key/value rows), `beforeSequence` and `afterSequence` (steps with `label`, `code`, `note`, `muted`, `flagged`) |

Top-level `rules.rtdb` and `seedFile` give the sandbox its Rules and data.
`stage.slots.collapseSidebar` collapses the app's left nav (on by default).

To build before and after for a PR, follow [VERIFY.md](VERIFY.md).

## 3. The 8-slide story

| # | Slide | Stage id | Shows |
|---|---|---|---|
| 1 | Title | `title` | `copy.title`, `copy.summary`, severity |
| 2 | Demo | `attach-demo` | Both actors in the app before anything happens |
| 3 | Path | `path-slide` | The data path with its variables marked |
| 4 | Problem | `problem-slide` | What the actor does and what peers see |
| 5 | Problem on the UI | `problem-video` | The capture, spotlighting the element that goes wrong |
| 6 | Why | `why-slide` | The sequence, highlighting the step that goes wrong |
| 7 | Fix | `fix-slide` | The sequence after the change, highlighting what moved |
| 8 | Fix demo | `fix-video` | The capture on the fixed rules or build |

Copy keys: `title`, `summary` (`repro` is accepted as an alias), `pathTitle`,
`pathContext`, `attackTitle`, `attackContext`, `whyTitle`, `why`, `fixTitle`,
`fixContext`, `severity`. Write short, plain sentences. Name what the user loses.

## 4. Visual rules

- `#212121` surface, monochrome white and gray only.
- Left-aligned type scale. No eyebrow labels.
- Never a colored left border.
- No middot or bullet separator characters (U+00B7, U+2022). No "Scene" labels.
- Not everything in a card. No large code blocks: show the access pattern.
- Collapse the app's left nav.

## 5. Gates

All six gates (`G1` through `G6`) are hard gates. Numbering follows
`scripts/lib/gates.mjs`; if any gate fails, `record.mjs` and `render.mjs` remove
any rendered `video.mp4` or `preview.gif`, write `status: "not-reproduced"` with
`failedGate` in `manifest.json`, and exit non-zero.

| Gate | Name | Passes when |
|---|---|---|
| G1 | Preconditions | The probe is `confirmed` or `local-counterexample`, and its target, mutation path, and seed envelope are valid (build variant: both builds, the scenario, and any seed envelope validate) |
| G2 | Baseline | The control operation is allowed (build variant: both actors appear on the before build) |
| G3 | Reproduce | The repro succeeds and touches the expected path, or for read operations is `ALLOW` and returns protected data at the target path (build variant: the `check` still finds the entry after the action, decision `LEFT BEHIND`) |
| G4 | Visible effect | The app view or the data-plane diff/returned read payload shows the effect (build variant: no separate check; it rides on G3, so confirm the spotlight in keyframe QA) |
| G5 | Fix verification | Under the fix, the repro returns a genuine rule `DENY` (non-rule errors count as `ERROR` and fail G5) with no changed paths and the control still passes (build variant: the entry is gone within `waitMs`, decision `REMOVED`) |
| G6 | Render integrity | Video duration and dimensions, no dropped frames, non-blank poster and keyframes, motion, locked provenance strip, secret and PII scan across copy/slides/beats/share markdown, and scenario plus generated slide/beat copy consistent with events |

Copy must not say "fixed" or "blocked" unless the fix decision is `DENY`. A
build-variant fix is `REMOVED`, so describe what the change does instead
("Clean up first, then sign out").

`[data-pyric-provenance]` must stay visible, unclipped, at 10px or larger,
with the exact verdict text. A custom stage that hides or edits it fails with
`PROVENANCE_TAMPERED`.

## 6. Known sandbox limits

- Rejected listener events after sign-out aren't logged.
- The ToS dialog doesn't close; it is hidden during recording.
- Throttled or delayed writes may never fire.
- Pre-G5 state resets restore JSON values and do not preserve Realtime Database `.priority` metadata.

Claims that depend on these need the Firebase emulator. Report them as not
observable in the sandbox.

## 7. Commands

Record and render:

```bash
node pyric-plugin/skills/improve-firebase/scripts/record.mjs \
  --scenario /tmp/scenario.json \
  --out /tmp/pyric-evidence \
  --render --formats mp4 --json
```

Add `--rtdb-rules <fixed.json>` (rules variant only) to supply fixed Rules on
the command line. `--fps`, `--seed`, `--stage <custom.html>`, and
`--size WxH` are optional.

Re-render an existing bundle without rerunning the sandbox:

```bash
node pyric-plugin/skills/improve-firebase/scripts/render.mjs \
  /tmp/pyric-evidence/<probe> --formats mp4,gif --json
```

The bundle is `<out>/<probe>/`: `video.mp4`, `poster.png`, `storyboard/*.png`,
`manifest.json`, `evidence.json`, `events.json`. `manifest.json` has the gate
results. `storyboard/` holds four legacy beat keyframes (`hook`, `repro`,
`fix`, `takeaway`), not one per slide.

## 8. Keyframe QA

Before sharing, pull frames from `video.mp4` and open them with your image
tool. Find the slide boundaries with a 1 fps contact sheet, then extract one
full-size frame from the middle of each slide:

```bash
ffmpeg -v error -i video.mp4 -vf "fps=1,scale=480:-1,tile=7x4" -frames:v 1 /tmp/contact.png
ffmpeg -v error -ss <sec> -i video.mp4 -frames:v 1 /tmp/slide-<n>.png
```

Slide 2 starts after both actor views are signed in and prepared (the
recorders put `uiReadyAtMs` on the control event), so startup dialogs should
never show; check its first frame anyway. At minimum, check slides 2, 5, 7 and 8:

1. The spotlight sits on the element that changes, and the actor view is sharp.
2. The info bar is solid and readable, and nothing overlaps the provenance strip.
3. Everything is monochrome on `#212121`, with no middots and no colored borders.
4. Text never clips or overflows.
5. If `manifest.json` has `fixAssurance.verified: false`, the assurance line is visible on slides 7 and 8.

Then share the video path, severity, root cause, and the fix.

## 9. Worked example: The fix

The fix moved presence cleanup ahead of `signOut(auth)` in a shared-chat app. On the old
build, Alice signs out and Bob keeps seeing her. On the new build, her entry
is removed about 350 ms after sign-out. Both builds use the same Rules, so
this is the build variant.

```json
{
  "schema": "pyric.evidence.scenario.v1",
  "finding": { "campaign": "chat-audit", "probe": "signout-ghost-presence" },
  "app": { "dist": "/tmp/pyric-372-check/dist" },
  "rules": { "rtdb": "/tmp/pyric-372-check/database.rules.json" },
  "seedFile": "/tmp/pyric-372-check/seed.json",
  "actors": {
    "owner": { "uid": "alice", "name": "Alice", "view": "/s1/chat/pub", "claims": { "hasAccess": "granted" } },
    "peer": { "uid": "bob", "name": "Bob", "view": "/s1/chat/pub", "claims": { "hasAccess": "granted" } }
  },
  "behavior": {
    "fixApp": { "dist": "/tmp/pyric-372-after-dist" },
    "action": { "kind": "sign-out", "actor": "owner", "menuItemText": "Sign out" },
    "check": { "kind": "presence-entry", "path": "/app/rooms/s1/presence", "uid": "alice", "waitMs": 3000 },
    "focusSelectors": { "peer": "[class*=\"pile\"]" },
    "pathTemplate": "/app/rooms/$roomid/presence/$clientId",
    "pathValues": { "$roomid": "s1", "$clientId": "Alice's tab" },
    "pathCallouts": {
      "$roomid": { "label": "Shared space", "detail": "Alice and Bob are both members (s1)" },
      "$clientId": { "label": "One entry per open tab", "detail": "Alice's tab writes it, Bob's facepile reads it" }
    },
    "watchMethod": "onValue",
    "deck": {
      "problemFacts": [
        { "key": "Action", "val": "Account menu, then Sign out" },
        { "key": "Entry", "val": "presence/$clientId", "mono": true },
        { "key": "Peers see", "val": "Alice, until the entry goes stale (up to 4 minutes)" }
      ],
      "beforeSequence": [
        { "label": "Revoke credentials", "code": "await signOut(auth)", "muted": true },
        { "label": "Unmount the space", "note": "Cleanup runs here, after credentials are gone", "muted": true },
        { "label": "Delete presence entry", "code": "remove(presence/$clientId)", "note": "Runs signed out, so the entry stays", "flagged": true }
      ],
      "afterSequence": [
        { "label": "Delete presence entry", "code": "remove(presence/$clientId)", "note": "Runs while Alice is still signed in", "flagged": true },
        { "label": "Unmount the space", "muted": true },
        { "label": "Revoke credentials", "code": "await signOut(auth)", "muted": true }
      ]
    }
  },
  "copy": {
    "title": "Signing out leaves you visible in the space",
    "summary": "When Alice signs out, a shared-chat app revokes her credentials before it cleans up. Her presence entry is left behind, so Bob keeps seeing her.",
    "pathTitle": "Where presence lives",
    "pathContext": "Each open tab writes one entry here. Peers draw the facepile from this list, so the tab has to delete its own entry while it is still signed in.",
    "attackTitle": "Alice signs out",
    "attackContext": "Nothing malicious. One normal click leaves a ghost behind.",
    "whyTitle": "Why the entry stays",
    "why": "Credentials are revoked first. The cleanup that deletes the entry runs afterward, signed out, so it can't remove it.",
    "fixTitle": "Clean up first, then sign out",
    "fixContext": "The fix deletes the entry and detaches listeners while Alice is still signed in.",
    "severity": "MEDIUM"
  },
  "stage": { "slots": { "collapseSidebar": true } }
}
```

A full run (two sandboxes, capture, render) takes about 60 seconds.
