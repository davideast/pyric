# Studio Design Workflow

How a view goes from idea to shipped UI without vibe-designing and without
mock drift.

## Why static mocks failed, and the replacement

Static mocks are a parallel artifact: separate files, separate CSS, no
tokens, no components. When implementation starts, the agent re-derives the
UI from the prompt, not the mock, and the two diverge. The fix is to remove
the parallel artifact entirely:

1. **The spec (prose + grid sketches) is the design artifact.** It travels
   in the repo, is reviewable as a diff, and is written in terms the
   implementation must literally satisfy (content tiers, disclosure
   mechanisms, grid contracts, URL states).
2. **The canvas is the real app.** Studio's dev-seed build (`vite dev` with
   `DevSeedProvider`) runs serverless with seeded data — that is where
   layout exploration happens, using real tokens and real `@pyric/ui`
   components, behind a dev flag when the work is exploratory. There is
   never a "port from mock" step.
3. **Conformance is checked mechanically**, not by trusting the agent's
   self-report.

## The loop, per view

### 1. Spec (prose)

Write or amend `docs/design/specs/<view>.md` from the template. The content
inventory and the foundation grid sketch are the negotiation surface —
agreement happens here, cheaply, before code.

### 2. Build in the real app

Implement against the dev-seed build. Exploratory variants live behind a dev
flag route in the real app (P2). Agents doing this work load the
design-principles skill (below) so L/C/N rules ride in their context.

### 3. Verify (three mechanical passes)

- **Design lint (static).** A script (`scripts/design-lint.mjs`, to be
  built) over feature CSS and component source:
  - flag `margin-*` used between siblings in layout CSS (L2) — allowlist for
    genuine exceptions, each pointing at a spec justification;
  - flag fixed pixel widths/heights outside the token sheet (L1);
  - flag component root styles setting width/margin (L3);
  - flag more than one element matching the header-bar contract (N1).
- **Spec conformance review (agent).** A reviewer agent gets the spec + the
  rendered DOM/screenshots and checks every inventory row: each
  primary/secondary item visible in the default render; each tertiary item
  absent from default render and reachable via its declared disclosure; the
  primary action singular; each URL state loads. Output is a per-row
  pass/fail table citing rule IDs — not an impression.
- **Screenshot matrix (visual).** Playwright drives the dev-seed build at
  three widths × the spec'd states (empty / dense / disclosed) and attaches
  the grid of shots to the PR. Review compares shots against the spec's
  states section — against intent, not pixels.

### 4. Reconcile

Where reality beat the spec, update the spec in the same PR (P3). A view
change without a spec touch needs an explicit "no spec change because…"
line in the PR description.

## Making agents obey it

- **A repo skill** (e.g. `.claude/skills/studio-design/`) that loads
  `PRINCIPLES.md`, the spec template, and the lint/verify commands whenever
  UI work starts. This is the direct fix for "the agent ignored the mocks":
  the constraints are in-context at build time and machine-checked after.
- **CLAUDE.md pointer** so any session touching `packages/studio` knows the
  specs directory is normative.
- The conformance review can run as a `/code-review`-style pass over UI PRs.

## Order of first specs

1. `shell.md` — the header and navigation (sacred space first; everything
   else composes inside it).
2. `home.md` — the hub.
3. `rules.md` — the rules workbench (largest new mechanical surface).
4. Data tabs (`firestore.md`, `auth.md`, …) — mostly codifying what exists,
   then trimming to tier rules.
5. `prototype.md` — the embedded prototyping surface and its seam.
