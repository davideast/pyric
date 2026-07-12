---
title: "pyric deploy agent I/O: --schema and --json"
navLabel: "pyric deploy agent I/O"
group: "pyric-tools / deploy"
section: "Reference"
order: 10015
---
# `pyric deploy` agent I/O: `--schema` and `--json`

The deploy CLI wraps `ToolHandler`s, and **the ToolHandler is the
schema**. There is no hand-authored copy to drift. Three knobs
(wired for `hosting` today; `rules` / `indexes` / `functions` are
follow-ups and reject the flags with a clear error):

## `pyric deploy hosting --schema`

Prints the `hosting_deploy` handler's `parameters` JSON
Schema to stdout (pretty-printed) and exits 0.

- Needs **no credentials and no firebase.json**: introspection only.
- Pipe it to an agent so it can construct a valid `--json` payload.

## `pyric deploy hosting --json '<payload>'`

Validates the payload against that same schema and feeds it to the
handler **directly**.

- **Bypassed:** firebase.json, `--only`, `--channel*`, and every other
  hosting flag: the payload IS the whole tool input.
- **Still applies:** project + credential resolution (`--project`
  alias-or-id → `PYRIC_PROJECT` → `.firebaserc` `projects.default`;
  `FIREBASE_SA_BASE64` / `GOOGLE_APPLICATION_CREDENTIALS`).
- **stdout:** on success, exactly the handler result
  (`{ "ok": true, "summary": …, "data": … }`) as one JSON object.
- **stderr:** JSON errors. A payload that isn't valid JSON, isn't an
  object, or fails schema validation prints
  `{ "ok": false, "summary": …, "details": [ … ] }` and exits **1**
  with no tool call. A handler failure prints the handler's result and
  exits **2**. Diagnostics (the "using project …" banner, typo-guard
  warnings for payload keys not in the schema) are plain text on
  stderr.
- **Exit codes unchanged:** 0 success, 1 usage/validation, 2 runtime.

```bash
pyric deploy hosting --json '{
  "siteId": "my-site",
  "localDir": "./dist",
  "config": { "cleanUrls": true,
              "rewrites": [{ "source": "**", "destination": "/index.html" }] },
  "channelId": "pr-42"
}'
```

## `pyric deploy hosting --json` (bare)

Machine-output mode for a normal, fully-resolved deploy: firebase.json,
`--only`, channel flags, and `.firebaserc` all behave exactly as
without the flag (mirror of firebase-tools' global `-j, --json`,
`src/index.ts:16`). The handler result goes to stdout as JSON, one
object per deployed site (NDJSON when a target maps to several sites);
failed deploys print their result to stderr as JSON and exit 2. The
project banner moves to stderr so stdout stays pure JSON.

> Flag-parsing note: put `--json` after the target
> (`pyric deploy hosting --json`); written before it, the parser would
> read `hosting` as the payload.

## Precedence summary

| Mode | Config source | Output |
|---|---|---|
| (no flags) | firebase.json + flags | human text |
| `--json` (bare) | firebase.json + flags | JSON results |
| `--json '<payload>'` | the payload only | JSON results |
| `--schema` | n/a | the tool's JSON Schema |
