# Studio Design Principles

Normative rules for all Studio UI. Every rule has an ID so specs, reviews,
and lint findings can cite it. MUST rules are checkable and enforced; SHOULD
rules require written justification in the view spec to break.

## Model (M)

Derived from the assists post-mortem (`TOOL-SYSTEM.md` failure ledger).
These outrank everything below: a view that satisfies L/C/N but violates M
is still wrong.

- **M1** The system is mechanical tools producing typed results (one
  registry). Every view is either a dedicated home for a dataset/workbench
  or a dynamic layout of result renderers. A feature that can't be named as
  tool + result + surface doesn't ship.
- **M2** No ambient or global modes. Identity, policy, and other
  cross-cutting parameters are explicit inputs of the specific operation
  that needs them, set where used and shown where set.
- **M3** Data views are always admin. "What can user X see/do" is a
  filter/query or a simulation — never a viewing mode.
- **M4** One concern per surface. Settings, prompts, and results never
  share a control surface; a command input's results contain actions and
  routes, never configuration.
- **M5** Every result type has exactly one renderer, shared by mechanical
  and AI paths. AI adds narration around renderers, never replacement UI —
  so every AI feature's mechanical fallback is automatic.
- **M6** Rendered results are actionable or silent: a result offers derived
  next actions (at most one primary) or presents nothing interactive. No
  heaps of standing controls; controls exist only as parameters of the
  stage they belong to.
- **M7** Governance applies only to agent-initiated mutations and surfaces
  at the moment it fires (on the staged item or blocked call), never as a
  standing mode indicator.
- **M8** Tool exposure is a per-caller decision (MCP, in-browser agent,
  mechanical UI) recorded in the exposure matrix (`TOOL-SYSTEM.md`). A tool
  absent from a caller without a recorded reason is a defect, not a
  default.
- **M9** No surface is grandfathered. "Already built" is not a tier;
  every existing tab re-enters through a spec and must prove its worth
  against C1–C4 or be reworked/retired.

## Layout (L)

- **L1** Foundation layouts MUST use modern intrinsic CSS: grid/flex with
  `auto-fit`/`auto-fill`, `minmax()`, `fit-content`, `min()`/`max()`/`clamp()`.
  Layouts adapt by intrinsic sizing first; media/container queries are a
  refinement, not the mechanism.
- **L2** Spacing between siblings MUST come from `gap` (or grid track
  definitions). `margin` MUST NOT be used to nudge position between siblings.
  `padding` is for a container's internal breathing room only.
- **L3** Components MUST NOT style their own external geometry: no outer
  margins, no self-imposed widths on the root. The root fills its container;
  the parent decides placement and sizing.
- **L4** Component-local layouts MUST be container-agnostic: they organize
  their own content with their own grid/flex and adapt to available width
  intrinsically (or via container queries), never by knowing where they are
  mounted.
- **L5** One scroll owner per region. Content wider than its region scrolls
  inside its own container; the foundation never scrolls horizontally.
- **L6** Unbounded collections (event logs, document lists, user lists)
  MUST render through virtualization. A view never mounts an unbounded DOM
  list.

## Content (C)

- **C1** Every view and every component MUST have a written content inventory
  classifying each content item as **primary**, **secondary**, or
  **tertiary** (see `specs/TEMPLATE.md`).
- **C2** The default render shows primary and secondary content only.
- **C3** Tertiary content is reached through interactive disclosure, in order
  of preference: drill-in (route change), detail pane, popover, expandable
  row. A modal is a last resort and MUST carry a written justification in the
  spec.
- **C4** A view has exactly one visible primary action. Additional actions
  are secondary (visible but subordinate) or tertiary (disclosed).
- **C5** Empty, loading, dense, and narrow states MUST be specified. Empty
  states teach the primary action; they are onboarding, not apology.

## Navigation (N)

- **N1** One header bar. No stacked or secondary bars, ever.
- **N2** The bar contains only load-bearing, always-relevant items:
  navigation and global status. Contextual actions and controls live in the
  surface they act on, never in the bar.
- **N3** The bar is sacred space: nothing enters it without an amendment to
  `specs/shell.md`. Default answer is no.
- **N4** Every navigable state has a clean History-API URL (no hash
  routing). Views, selections, and disclosed drill-ins that a user would
  share or reload into MUST be addressable.

## Process (P)

- **P1** Spec before implementation: a view's spec (`docs/design/specs/`) is
  written and agreed before its UI is built or reworked.
- **P2** No parallel mock artifacts. Design iteration happens in the real app
  (dev-seed build), behind a dev flag when exploratory. Promotion is removing
  the flag, not porting a mock.
- **P3** Reality wins, then the spec catches up: any PR that changes a view
  MUST update its spec or state why no update is needed.
- **P4** Ideas from the removed assists layer re-enter only through the
  `TOOL-SYSTEM.md` failure ledger's stated door and a new spec. Assist-era
  forms, names, and concepts-as-framed (assist, lens, dial, proposals
  queue) are not starting points; treat their UI as harmful until
  re-derived from the tool model.
