# Spec: <view or component name>

Route: `<clean URL under /__pyric/ui/>`
Status: draft | agreed | built | drifted

## Purpose

One sentence: the user question this view answers.

## Content inventory

| Item | Tier | Rendering | Rationale |
|---|---|---|---|
| <content item> | primary | direct | why it earns default visibility |
| <content item> | secondary | direct (subordinate) | |
| <content item> | tertiary | drill-in → `<route>` / detail pane / popover | why disclosure, and which kind |

Rules: tiers per C1–C4. Every tertiary row names its disclosure mechanism
and, for drill-ins, the URL (N4). A modal requires a justification sentence
here (C3).

## Primary action

The one visible primary action (C4), and where secondary actions live.

## Foundation layout contract

Prose description of the regions, plus the actual grid sketch — the sketch
is the design artifact, not a mock:

```css
.view {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: var(--space-...);
}
.view__body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(24rem, 1fr));
  gap: ...;
}
```

State which region owns scroll (L5).

## Local layouts

Per component placed in the foundation: how it organizes its own content
internally, and confirmation it assumes nothing about its container beyond
available width (L3, L4).

## States

- Empty: what it shows, what it teaches (C5)
- Loading:
- Dense (lots of data):
- Narrow (~1 column):

## URL states

Every addressable state of this view and its params (N4).

## Open questions / justifications

Any SHOULD-rule breaks, modal justifications, deferred decisions.
