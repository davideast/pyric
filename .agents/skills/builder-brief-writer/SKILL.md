---
name: builder-brief-writer
description: Write the briefs for a round of pyric's app-builder pilot, one JSON file per brief, aimed at the weak areas of the evidence map. Use when asked to write, check or revise builder briefs for a round. Not for running a round (`bun test/builders/harness.ts round`) or verifying one (builder-verifier).
---

# Builder brief writer

Each brief sends one cheap builder at one weak area of pyric, pushed past
the surface. A good brief makes a builder do something no existing check
does, and names what production refuses so the builder has to try it.

## Inputs

Two directories, each a setting:

- the **ops directory**, `PYRIC_OPS_DIR` when it is set, otherwise
  `pyric-ops` in the home directory. It holds the evidence map and the ideas.
- the **data root**, `PYRIC_BUILDERS_DATA_DIR` when it is set, otherwise
  `pyric-ops/assurance/builders` in the home directory, as
  `test/builders/round-paths.ts` resolves it. The harness reads briefs from
  it and keeps runs in it.

Read all three inputs before writing anything:

1. **Weak areas.** The evidence map,
   `<ops directory>/assurance/change-map-alpha30.md`, and the registry
   rows still `automation: "unverified"` in
   `packages/conformance/registry/*.ts`. An area is weak when it changed a
   lot since alpha.30 and no app scenario under `test/apps/` drives it, or
   when its rows are unverified.
2. **Ideas.** `<ops directory>/builder-ideas.md`: app ideas and the
   five stress dimensions (scale, lifecycle, integration, combination,
   concurrency). Use an idea when one fits the area.
3. **Production's behavior.** Firebase's own documentation on
   `firebase.google.com`. Every must-be-refused line cites one of its pages.
   Never call production to find out; a page is the evidence.

## Rules

- One target area per brief, and one or two stress dimensions.
- The app must be buildable from pyric's public docs alone
  (`packages/site-docs/src/content/`): name each feature the way the docs
  name it.
- Nothing in a brief needs production, a real credential, a deploy, or a
  native client (Android, iOS and Flutter are parked in #1048).
- Two to five must-be-refused actions, each something a user of the app
  could do, with production's exact answer (an error code such as
  `permission-denied` or `storage/unauthorized`, or an HTTP status).
- The model and the dollar cap are not in the brief: `round` runs each
  brief once per model at one cap.
- Briefs of one round differ in area, so the comparison between models is
  per brief and the round covers more than one area.

## The file

One file per brief, `<data root>/briefs/<round>/<round>-<n>.json`.
`test/builders/brief.ts` holds the shape; a field it doesn't name fails.

```json
{
  "id": "r1-1",
  "targetArea": { "area": "one area from the evidence map", "whyWeak": "the evidence: commits since alpha.30, no scenario, unverified rows" },
  "stressDimensions": ["combination"],
  "appIdea": "one paragraph",
  "framework": "next-16 | vite | node-server",
  "features": ["named as the docs name them"],
  "userJourney": ["what a person does, step by step"],
  "mustBeRefused": [
    { "action": "another user's write under the given rules", "firebaseDoc": "https://firebase.google.com/docs/...", "productionAnswer": "permission-denied" }
  ],
  "limits": { "wallClockMinutes": 45 }
}
```

`test/builders/fixtures/briefs/brief-1.json` is a complete example.

## Check

```
bun test/builders/harness.ts check-briefs <round>
```

validates every brief of the round as `round` would and starts nothing. Fix
each error it names. Then tell David the round is ready: the briefs, the
area each targets, and why that area is weak.
