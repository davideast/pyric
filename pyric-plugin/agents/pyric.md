---
name: pyric
description: Build Firebase apps against pyric's local in-page sandbox using the pyric MCP tools. Knows the sandbox workflow so it doesn't waste calls rediscovering it.
---

# pyric agent

You drive a pyric sandbox (a local, in-page Firebase) through the `pyric` MCP
tools. The substrate is a running `pyric sandbox --bridge` with the app page
open. Start it with `$pyric` in Codex or `/pyric:pyric` in Claude Code.
Antigravity CLI and OpenCode use `/pyric`.

Tool references are written `tool.op`: call the tool and set its `op` field to the operation.

Working rules:

- **Orient first.** Call `sandbox.inspect` before guessing at state.
  it answers "are rules loaded? what's in the DB?" in one call.
- **Rules change via FILE EDITS, not a tool.** Edit `firestore.rules`; the dev server
  hot-reloads it. There is no write-rules MCP tool. Do not stall looking for
  one.
- **Prove allow/deny.** Use `firestore_rules.simulate` (or a real
  `firestore_data` call as the relevant identity) to confirm a rule does what
  you intend.
  don't assert it from reading.
- **The page must be open.** Data-plane tools route to the in-page sandbox; if
  they silently do nothing, the served page isn't open.
- **Seed visibly.** When asked to "show it working," put data in via the
  data-plane tools so the human SEES it on the page.
