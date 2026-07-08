# Spec: Home (the hub)

Route: `/__pyric/ui/` (default)
Status: draft

## Purpose

Answer "what is happening in my sandbox, and what do I do next?" and route
into the surface that does it.

## Content inventory

| Item | Tier | Rendering | Rationale |
|---|---|---|---|
| Command input (one box: deterministic actions + routes; NL when a key exists) | primary | direct, top of view | the agent-forward front door; degrades mechanically. Results contain actions and routes only — never settings (M4); NL results render through the shared result renderers (M5) |
| Live activity feed (writes, denials, deploys, seeds; provenance-stamped) | primary | direct; each row links to its subject | the "it's real and working" signal, incl. external-agent work |
| Sandbox status line (branch, persistence mode, rules drift repo↔sandbox) | secondary | direct, single compact row of chips | glanceable confidence; each chip links to its surface |
| Surface tiles with live counts (docs, users, denials…) | secondary | direct, below feed | discovery + routing for console-first users |
| Event detail (full payload, trace) | tertiary | drill-in → subject's tab (e.g. `/rules?denial=…`, `/firestore/<path>`) | detail belongs to the owning surface, not the feed |
| Feed filters (by service, by identity/agent) | tertiary | popover on the feed header | tuning, not first-look content |
| Maintenance (reset, export/import, branches) | tertiary | drill-in → Settings; drift chip links to Rules | destructive/rare |
| MCP setup snippet, seed builder, rules import | tertiary normally; promoted into the empty state | direct within empty state only | onboarding is the empty state's job (C5) |

No chat thread renders on Home in phase 1. Conversation history is a
session-store concern shared with Prototype (see redesign doc §sessions);
Home's command input stages single actions, it does not host a dialogue.

## Primary action

The command input. Secondary: tile navigation, status-chip links.

## Foundation layout contract

```css
.home {
  display: grid;
  grid-template-rows: auto auto 1fr; /* command | status | body */
  gap: var(--space-5);
  /* readable measure without margin-centering: */
  grid-template-columns: minmax(0, 72rem);
  justify-content: center;
}
.home__body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr));
  gap: var(--space-5);
  /* feed spans available columns first; tiles flow after */
}
.home__tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: var(--space-3);
}
```

Scroll owner: the view content region (feed grows; page scrolls as one) —
the feed is not an inner scroll trap on Home; full history lives in Traffic.
Feed on Home is capped (latest N) with a drill-in link to Traffic.

## Local layouts

- Command input: single-row grid `1fr auto` (input | hint/key-state); result
  list renders below in its own flow, gap-spaced.
- Feed row: grid `auto 1fr auto` (provenance dot+identity | summary | time);
  truncates middle; no internal margins.
- Status chip / tile: intrinsic content boxes; tiles are a label + live
  count + spark of recency; no fixed widths (L1, L3).

## States

- Empty (fresh sandbox): status row + three onboarding cards in the body
  grid — connect your agent (MCP snippet), seed data (opens seed builder),
  bring your rules (repo file detected → deploy). Command input present with
  teaching placeholder.
- Loading: status chips skeleton; feed rows skeleton.
- Dense: feed capped at N with "view all in Traffic"; tiles unaffected.
- Narrow: everything single-column via auto-fit; order = command, status,
  feed, tiles.

## URL states

- `/` — hub.
- Feed rows navigate away (`/traffic?...`, `/rules?denial=…`,
  `/firestore/<path>`); Home itself keeps no deep state.

## Open questions

- Feed cap N and whether provenance filter state deserves a URL param.
- Whether the drift chip deploys directly (one-click) or always routes to
  Rules for review.
