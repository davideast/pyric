# Spec: Shell (header + navigation)

Route: all (frame for every view)
Status: draft

## Purpose

Get the user to the right surface and show, at a glance, whether the sandbox
and its agents are alive — nothing else.

## Content inventory

| Item | Tier | Rendering | Rationale |
|---|---|---|---|
| Tab navigation (Home, Firestore, Auth, RTDB, Storage, Rules, Traffic, Prototype, Settings) | primary | direct | the bar's reason to exist |
| Agent presence chip (MCP peer connected + client name) | secondary | direct, right cluster; details on popover | global status; true everywhere; one chip |
| Sandbox health (worker connected / stale-worker warning) | secondary | direct only when degraded; otherwise absent | status by exception — a healthy sandbox earns no pixels |
| Model/provider selection | tertiary | lives in the surface that uses it (Prototype), never the bar | contextual control; previous bar placement violated N2 |
| Branch / persistence details | tertiary | Home status region + Settings | glanceable on Home; not global chrome |

## Primary action

None — the bar navigates and reports; it does not act (N2). Anything
demanding an action (stale worker) links to the surface that resolves it.

## Foundation layout contract

One row, full width, fixed block-size row in the app grid; content region
takes the rest and owns scroll (L5).

```css
.shell {
  display: grid;
  grid-template-rows: auto 1fr;
  min-height: 100dvh;
}
.shell__bar {
  display: grid;
  grid-template-columns: auto 1fr auto; /* identity | nav | status */
  align-items: center;
  gap: var(--space-4);
  padding-inline: var(--space-4);
}
.shell__nav {
  display: flex;
  gap: var(--space-1);
  overflow-x: auto; /* nav scrolls before the bar wraps or stacks (N1) */
}
```

## Local layouts

- Nav tabs: flex row, gap-spaced, no per-tab margins (L2). Overflow scrolls
  horizontally within the nav region; the bar never grows a second row.
- Status cluster: flex row of chips, gap-spaced; each chip is
  container-agnostic (L4).

## States

- Empty/first-run: identical bar; onboarding lives in Home, not the bar.
- Degraded: single status chip appears (worker stale / bridge down).
- Narrow: nav scrolls; identity collapses to mark; status cluster keeps at
  most the presence chip.

## URL states

The bar itself holds no state; active tab derives from the path
(`/__pyric/ui/<tab>/…`).

## Open questions

- Does Prototype appear for keyless users? (Redesign doc recommends yes.)
- Exact right-cluster contents. Note: there is no lens or mode indicator
  anywhere in the bar — modes don't exist (M2/M3); identity appears only as
  a parameter on operations that take one.
