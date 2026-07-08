# The Tool System: Studio's Mental Model

Status: draft. This is the root document of the redesign — views, AI
features, and specs all derive from this model. If a proposed feature can't
be expressed in this model, the feature (or the model) is wrong, and that
gets resolved before any UI is designed.

## Why this document exists

The "assist" layer was UI-first design: AI features each got a bespoke
surface (palette, proposals queue, lens toggle, permission dial, sessions
digest, denial inspector) with no underlying system model. Each surface
invented its own relationship to data, identity, and action, so they were
individually confusing and collectively incoherent. The corrective is
model-first design: the system is **mechanical tools producing typed
results**, and all UI — dedicated views, search results, AI output — is
layout over those results. AI is a *caller* of the system, never a concept
in it.

## Failure ledger (assists post-mortem)

Binding design input. Each row: the idea worth keeping, why the form
failed, and the only door through which the idea may re-enter.

| Assist-era feature | The good idea | Why the form failed | Where the idea re-enters |
|---|---|---|---|
| ⌘K palette | An NL/keyboard entry point to actions | Mixed settings and prompts in one list; no model of what it operated on | A command input that only routes and stages tool runs; settings are reachable only as navigation to Settings, never inline results (M4) |
| Admin/app lens | "What does a user experience?" | A *global viewing mode*. Wrong model: a data viewer is not an authenticated user — a data viewer is always admin | Data views are always admin (M3). "What can user X see" is a filter/query or a simulation sweep. Impersonation exists only as an explicit parameter of the specific operation that needs it (simulate, preview), visible at the point of use (M2) |
| Proposals / Review UI | Staged, reviewable agent writes | A disconnected queue of diffs with no source context; "made no sense" | A staged change is a typed result (`StagedChange`) rendered *where the data lives* (pending marker on the doc/row) with the queue as a secondary index into those, not the primary residence |
| Sessions UI | Visibility into activity over time | A mishmash of data that was rarely actionable | Activity renders as provenance-stamped events, each carrying at most one derived action; anything non-actionable is disclosure-only (M6) |
| Permission dial | Governance over agent writes | Ambient mode with no visible moment of application; incomprehensible next to the lens | Policy applies only to agent-initiated mutations and surfaces exactly where it fires — on the staged item / blocked call — never as a standing mode indicator (M7) |
| Denial inspector | Denial debugging is the killer feature | A heap of controls piled on each other; no sequence | Denial debugging is a *pipeline* of tool results (below): each stage renders a result and derives the next action; controls appear only as parameters of the stage they belong to |

## The model

Three kinds of things:

1. **Tools.** Deterministic operations with typed inputs and one typed
   result. One registry (converging on `pyric-tools/registry`), four
   callers: mechanical forms, composition flows, external agents over MCP,
   and the in-browser agent. A caller never gets a capability the registry
   doesn't define.
2. **Results.** Typed values. **Every result type has exactly one
   renderer** — a container-agnostic component with the shape: subject
   header, result body, derived actions (at most one primary). Mechanical
   and AI invocations of the same tool render identically; AI adds only
   narration around renderers, never replacement UI (M5).
3. **Surfaces.** Two layout kinds:
   - **Dedicated views** — standing homes for a dataset or workbench
     (Firestore browser, Rules workbench, Traffic). Their specs live in
     `specs/`.
   - **Dynamic layouts** — runtime compositions of result renderers,
     produced by a search, a multi-step mechanical flow, or an AI turn: a
     gap-spaced stack of renderers, each collapsible, tertiary detail
     disclosed per C3. An agent turn is *not special*: it is a sequence of
     tool results rendered by the same renderers, interleaved with prose.

**The with/without-AI symmetry, stated once:** mechanical path = user fills
a form → tool → renderer. AI path = model chooses tools and arguments →
same tools → same renderers. Therefore AI can never have UI that mechanical
use lacks, and every AI feature's fallback is automatic: expose the form.

**Identity in the model:** there is no viewing identity. Data surfaces are
admin, always. Identity appears only as a *parameter chip* on operations
that take one (simulate as `alice`, preview as `alice`, coverage sweep over
[anon, alice, bob]) — set where used, shown where set.

## Tool inventory (initial)

| Tool | Input | Result type | Surfaces |
|---|---|---|---|
| `simulate_write` | op, path, data, identity | `Verdict` (allow/deny + trace) | Rules workbench form; denial pipeline; audit sweep |
| rules lint / validate | ruleset | `Findings` | Rules editor, inline |
| `try_rules_edit` (traffic replay) | edited ruleset + captured events | `RegressionTable` (op × old × new verdict) | Rules workbench |
| `inspect_denial` | event ref | `DenialDetail` (op, identity, rule trace) | Traffic drill-in → denial pipeline |
| `discover_paths` | sandbox | `PathTree` | Structure view; seeds audit sweep |
| `extract_indexes` | rules + observed queries | `IndexSet` (diffed vs repo file) | Rules workbench; repo write-back |
| seed data / seed users | seed spec | `SeedReport` / `SeedProposal` | Seed builder (form); AI proposal renders the same proposal type |
| fixture from session | session capture | `Fixture` (repo file) | Traffic/Home derived action |
| snapshot / branch / export | — | `StateRef` | Settings |
| staged mutation | write set | `StagedChange` (diff) | Inline pending markers + Review index |
| visibility query | path/query + identity set | `AccessReport` | Data-view filter; audit sweep |
| audit sweep (composed) | `PathTree` × ops × identities | `CoverageMatrix` | Audit view; AI narrates the same matrix |

## Composition

Tools compose when one's result type is another's input. Canonical chains —
these are the product, with or without AI:

- **Denial pipeline:** `TrafficEvent(denied)` → `DenialDetail` →
  `Verdict` (re-simulate, parameters editable) → edit rules →
  `RegressionTable` (replay all captured traffic) → deploy to sandbox /
  save to repo.
- **Modeling loop:** `PathTree` → `SeedProposal` → `SeedReport` →
  `CoverageMatrix` → `IndexSet` → repo write-back.
- **Audit:** `discover_paths` × identity set × ops → `simulate_write` sweep
  → `CoverageMatrix`.

An AI "skill" is a named composition plus narration. A mechanical "flow" is
the same composition driven by forms. Both render the same chain of
results, which is why the website demo and the keyless dev experience are
the same product.

## Session identity and provenance

One idea from the assists era survives on its merits: **naming the sandbox
session so it is identifiable across tools.** The running sandbox session
gets a stable id plus a human-readable name, and that identity is stamped
everywhere work is recorded: every `TrafficEvent`, fixture, capture file,
branch, audit-log line, and MCP tool response tag (`_pyric:{...}`). Home's
status strip shows it; `pyric verify` reports cite it; "captured from
session <name>" makes fixtures and replays traceable. Provenance on an
event is therefore two facts, both mechanical: *which session* and *which
caller* (app, Studio, in-browser agent, MCP client name) — never a mode.

**Engineering requirement — addressable events.** Every `TrafficEvent`
needs a stable id that survives the worker feed, so events are deep-linkable
(`/traffic/<eventId>`) and cross-linkable: an event links to its *subject*
(the Firestore/RTDB/Storage path or Auth user it touched) and to its
*consequence* (a denial links into the denial pipeline; a write links to
the record it produced). An event that can't be linked can't be composed.

## Traffic is a projection, not the substrate

The sandbox thinks in **events**; users think in **traffic**. Traffic is
the user-facing projection of the unified event stream — the actionable
subset, service-tagged. There is deliberately **no raw events view**: an
events UI would be an internals debugger nobody asked for, and every
legitimate use ("what touched this path," "why was this denied") is a
traffic question. The event stream remains the substrate (it is what the
worker fans out and what renderers subscribe to), and if an internals view
is ever needed it is a disclosure inside Traffic, not a surface.

Traffic is **multi-service by design**: Firestore and RTDB emit traffic
today; Auth and Storage must join. Service is therefore a first-class
dimension of the `TrafficEvent` result type (a tag on the row, a filter on
the view) — never a reason for parallel per-service traffic surfaces or
per-service traffic tools.

## Tool API design (T rules)

The current tool inventory was grown by a mixture of behavior-first design
(preferred) and mechanical granularity (often necessary, never preferred).
Models pay a real tax per tool for discovery and composition; models are
simultaneously getting better at richer parameter APIs, and tools can
validate input and return corrective errors. That shifts the design toward
**fewer, behavior-named tools with well-typed parameters**. Pre-npm is the
moment: renames are free today and get progressively more expensive.

- **T1** Consolidate by behavior (the verb), discriminate by parameter.
  When two tools do the same behavior over different services and share a
  result type, they are one tool with a `service` parameter
  (`inspect_traffic`, not `firestore_*` + `rtdb_*` twins). Split only when
  parameters stop sharing meaning — a discriminated union that degenerates
  into per-service conditional mazes is the signal to split (e.g.
  Firestore structured queries vs RTDB tree reads may earn separate tools;
  path-level read/write may not).
- **T2** The MCP surface is a curated façade, not a dump of the internal
  registry. Granular tools may live on as programmatic APIs; what a model
  sees is the consolidated set. Target roughly a dozen tools; every
  addition must justify itself against consolidation first.
- **T3** Tools validate input and return corrective, teachable errors
  (what was wrong, what valid looks like). This is what makes richer
  parameter APIs safe for models and forms alike.
- **T4** Result types are service-tagged, never service-named, wherever
  semantics are shared (`TrafficEvent{service}`, not
  `FirestoreTrafficEvent`).

### Candidate consolidated MCP façade (to be finalized early-alpha)

`inspect_traffic` (cross-service query; `eventId` returns full detail incl.
rules trace — absorbing `firestore_simulator_events`, playground
inspect-traffic/denial), `simulate_access` ({service, op, path, data,
identity} — absorbing `firestore_simulate_rules` + `rtdb_simulate_access`),
`lint_rules`/`validate_rules` (service param), `replay_traffic`
(try_rules_edit), `discover_structure` (absorbing discovery +
`rtdb_crawl_structure`), `extract_indexes`, `seed_data`, `seed_users`,
`save_fixture`, `sandbox_inspect`, data read/write/query (per-service split
is the open T1 judgment call), deploy gates.

## Exposure matrix (per M8)

Every tool declares, per caller, exposed-or-not **with a reason**. Current
known state — `gap` rows are defects to fix, `deliberate` rows are design:

| Tool | MCP | In-browser agent | Mechanical UI | Status / reason |
|---|---|---|---|---|
| `inspect_firestore_traffic` | ✗ → ✓ | ✓ | Traffic view | **gap** — an external agent debugging rules needs the same visibility the playground agent has |
| `inspect_denial` | ✗ → ✓ | ✓ | denial pipeline | **gap** — the killer feature must be reachable from Claude Code |
| `simulate_firestore_write` | ✓ (bridge rules tools) | ✓ | simulator form | ok; verify arg parity between the two implementations |
| `try_rules_edit` (replay) | ✗ → ✓ | ✓ | regression table | **gap** — rules iteration from an external agent is a core story |
| `discover_paths` / `firestore_discover` | partial | ✓ | structure view | audit needed |
| seed data / seed users | partial (data tools exist; bulk seed unclear) | ✓ | seed builder | audit needed |
| `generate_fixture_from_session` | ✗ → ✓ | ✓ | derived action | **gap** — pairs with `pyric verify`, an external-agent workflow |
| workspace file tools (read/write/edit) | ✗ | ✓ | editors | **deliberate** — external agents have their own filesystem; exposing a second one invites split-brain |
| checkpoints / `workspace_git` / GitHub tools | ✗ | ✓ | Prototype | **deliberate** — session-workspace concerns; external agents use real git |
| `bash` (VFS shell) | ✗ | ✓ | terminal | **deliberate** — same reason as file tools |

First action: a **parity audit** that diffs the three registries
(playground `src/lib/tools/`, bridge `tool-metadata.ts`,
`pyric-tools/registry`) and emits this matrix mechanically, so drift is
detected rather than remembered.

## What this document governs

- No feature ships without naming its tool(s), result type(s), and
  surface kind.
- New result type ⇒ new renderer spec (a `specs/` entry or an addition to a
  workbench spec).
- The registry convergence work (redesign doc, Phase 3) is what makes this
  model physically true rather than aspirational.
