# Pyric Studio Redesign: From Found to Intentional

Status: proposal draft, revision 1. Written 2026-07-08 against current `main`.

Revision 1 changes: the previously-mounted AI surfaces were removed on
purpose (bad form, good ideas) — nothing gets remounted as-is; routing is
History-API, not hash; "Build" is renamed "Prototype" and sessions become a
Studio-level primitive to avoid duplicate chat systems.

Revision 2 changes: the design roots in the mechanical tool system, not in
"assists" — see `TOOL-SYSTEM.md` (the root model document, including the
assists failure ledger) and PRINCIPLES M1–M7. Consequences applied here:
the global admin/app **lens is deleted as a concept** (data views are
always admin; identity is a per-operation parameter; per-user visibility is
a query/simulation), governance surfaces only where it fires, and staged
changes live inline where the data lives with Review as an index.

Revision 3 changes: **no tab is grandfathered** (M9) — "exists" describes
code, not approval; every surface re-enters through a spec. Traffic is
respecified (chart demoted, addressable + cross-linked events, virtualized,
`specs/traffic.md`). Session naming (an assist idea that survives) becomes
system-wide provenance. The tool exposure matrix (TOOL-SYSTEM.md, M8)
captures the playground↔MCP registry gaps. The playground Firebase Tab gets
a disposition plan, and deployment auth is simplified around a bundled
OAuth client brokered by `pyric serve`.

Revision 4 changes: traffic goes multi-service (a projection of the event
stream — no raw events view); tool API design rules (T1–T4) and a candidate
consolidated MCP façade added to TOOL-SYSTEM.md; and a **ship cut** section
added below to serve the npm-today goal — publish is gated on API
mechanics and naming decisions, not on UI.

Companion documents: `TOOL-SYSTEM.md`, `PRINCIPLES.md`, `WORKFLOW.md`,
`specs/`.

## Ship cut for npm alpha (added rev 4)

The publish constraint: npm today, alpha semantics (breaks are fine for
~a month, then progressively less fine). The UI ships inside `pyric-tools`
as an embedded asset and can change without any API break — so **the UI
does not gate the publish; names and packaging do.**

**Gate A — publish today (API mechanics + naming):**
1. The pre-npm P0 mechanics (this doc's earlier assessment + CONTEXT.md):
   packaging smoke-list sync, intentional versions, alpha-honest READMEs,
   gates run from a clean tree, embedded UI asset checks.
2. Tool-naming decision recorded, not implemented: adopt T1–T4 now, note in
   the MCP/README docs that the tool surface will consolidate during
   early alpha (so today's granular `firestore_*`/`rtdb_*` names carry an
   explicit instability notice). Add **no new tools today** — especially no
   new wrongly-scoped names (no `firestore_`-prefixed traffic tool).

**Gate B0 — remote sandbox for `pyric-admin` (top post-publish priority):**
A real first user (RTDB + Auth app, server-side architecture on the RTDB
Admin SDK) needs server-side `pyric-admin` code to reach the browser-hosted
sandbox. Design: a **remote `Sandbox` implementation** — since
`pyric-admin`'s entire seam is the `Sandbox` handle passed to
`initializeApp({ sandbox })`, a `connectRemoteSandbox()` (Node, in
`pyric-tools`) that satisfies the sandbox surface over the existing bridge
transport (WS `/__pyric/sandbox` → page relay → SharedWorker, the same
server→browser direction MCP tool forwarding already uses) plugs in with
zero `pyric-admin` changes and works for the client SDK in Node too.
Discovery via `.pyric/serve.json`, like `mcp-proxy`. Scope first slice to
RTDB + Auth ops. Accepted compromise: a browser tab must be open; failure
mode must say so ("open <serve url>"). Spike questions: sync-vs-async
surface of the `Sandbox` interface, listener (`on()`) relay over WS, and
reconnect semantics across tab refresh. Additive — does not gate Gate A.

**Gate B — core experience (first alpha days; UI-only, no breaks):**
The structure, core workflow, and feel — not every feature:
1. History-API routing + the route structure.
2. Shell per `specs/shell.md`: one bar, Prototype rename, model controls
   out of the bar.
3. Home v1: status strip + capped provenance feed + tiles. (The command
   input may land as navigation-only first.)
4. Traffic v1 per `specs/traffic.md` minus full addressability:
   virtualization (known failure), service dimension, subject links where
   derivable today.

**Gate C — early alpha window (breaks still free):**
1. MCP façade consolidation per TOOL-SYSTEM.md (renames done while free).
2. Stable event ids + session identity → full traffic addressability.
3. Registry parity audit mechanized.

Everything else (rules design track, seed builder, Review, Prototype
session protocol, deploy-auth simplification, Firebase Tab dissolution)
proceeds on the phased plan below, unhurried.

## Purpose

Redesign Pyric Studio as an agent-forward development console where the
traditional data views remain first-class, the "playground" concept dissolves
into an integrated assistant + opt-in prototyping surface, and every cognitive
(AI) feature has a mechanical fallback. The same design becomes the Pyric
website story: Studio running in the browser, showing instead of telling.

## The grounding insight

An audit of the current code shows the redesign is mostly *promotion and
wiring*, not new architecture:

1. **The data plane is already unified.** The app under test, Studio, the
   Playground (in shared mode), and external MCP agents all operate on the ONE
   `pyric-shared-worker` sandbox via `pyric-tools/serve/worker`. Agent writes
   already flow through the unified `SandboxEvent` stream Studio consumes
   (`host-events.ts` fan-out → `worker-live.ts` feed). "An agent just wrote 30
   docs" is observable *today*; it just isn't surfaced.
2. **Studio contains a de-mounted agent-forward layer whose ideas survive
   and whose form does not.** The ⌘K palette, proposals/Review, permission
   dial, Action Center, Rules surfaces, and Session digest exist in
   `packages/studio/src/` but were deliberately removed from the shell: they
   were confusing and hard to use. The concepts (staging, governance,
   visibility, NL-to-action) are load-bearing in this redesign, but each
   re-enters only through a fresh content-inventory spec (PRINCIPLES P4).
   The code is salvage material — data layers and tool plumbing are reusable;
   the UI forms are not a starting point.
3. **Almost every cognitive feature in the Playground is a thin AI layer over
   a deterministic tool.** The agent's power comes from its tool registry —
   rules lint/validate/simulate, denial inspection, traffic replay
   (`try_rules_edit`), index extraction, seeding, fixture generation, path
   discovery. Those tools are ordinary functions. The AI decides *which* to
   call and narrates; the machinery is mechanical.

That third point is the design key:

> **A mechanical fallback is not a degraded parallel feature. It is a
> form-driven invocation of the same tool the agent calls.**

Every capability becomes a triad: (a) a deterministic tool, (b) a mechanical
UI form over that tool, (c) an agent that can compose the tools. AI adds
composition and language, never exclusive access. This is also what makes the
website story honest: visitors without keys use the real tools; keys unlock
the narrator.

## Design principles

1. **One sandbox, one story.** Studio is a lens over the shared sandbox plus
   the local repo. Nothing in Studio owns private state that another surface
   can't see.
2. **Progressive cognition.** Mechanical → AI-assisted → agent-driven, on the
   same tools, in the same UI locations. No AI-key wall in front of any
   workflow; a key upgrades the workflow in place.
3. **The URL is the state.** Every view, selection, denial, session, and
   review item is deep-linkable via clean History-API routes under the app
   base (`/__pyric/ui/<tab>/<rest>?<query>`), replacing today's hash codec.
   The codec module survives; only its transport changes from `location.hash`
   to `pathname`. Serve's extension-less `index.html` SPA fallback already
   supports this. The hub routes *into* the traditional tabs via these URLs.
4. **External agents are the hero.** In local dev, the "agent" is usually
   Claude Code / Cursor / Codex on the MCP bridge, not an in-Studio chat.
   Studio's job is to make that activity visible, reviewable, and governable.
5. **The repo is the source of truth.** Rules, fixtures, seed data, and index
   files live in the user's repo; the sandbox is the running instance. Studio
   shows sync state and offers write-back, never becoming a second silo.
6. **App building is a cherry, not the frame.** Prototyping with preview,
   GitHub import/export, and deploy stays — as an opt-in surface, framed as
   "Build," not as the container everything else lives inside.

## Information architecture

### Navigation (top-level tabs)

| Tab | Contents | Status today |
|---|---|---|
| **Home** (the hub) | Command bar, live activity feed, sandbox status, connected-agent presence, guided routes | Exists as static tile grid; becomes the hub |
| **Firestore** | Data browser/editor | Exists |
| **Auth** | Identity admin | Exists |
| **RTDB** | Tree browser/editor | Exists |
| **Storage** | Object browser | Exists |
| **Rules** | Rules workbench: editor, lint, simulator, denial inspector, traffic replay, coverage | Machinery exists; UI form to be spec'd fresh (old surfaces removed) |
| **Traffic** | The addressable event store: virtualized log, events cross-linked to subject and consequence, denial → pipeline | Assists artifact; respecified in `specs/traffic.md` (chart demoted to disclosure) |
| **Review** | Index of `StagedChange` results; the changes themselves render inline where the data lives | Concept retained from removed proposals surface via TOOL-SYSTEM failure ledger; form to be spec'd fresh |
| **Prototype** (side feature) | The former playground: prototyping, preview, GitHub, deploy | Exists as `playground` tab; seam redesigned (see below) |
| **Settings** | Sandbox maintenance + AI providers/keys + governance | Maintenance exists; AI section to be spec'd fresh |

Notes:

- **"Status today" describes code, not approval (M9).** Every tab — data
  views included — gets a content-inventory spec and must prove its worth;
  "exists" surfaces are candidates for rework, not defaults.
- "Playground" as a name disappears. The agent isn't a place; it's a layer.
  The app-builder surface is "Prototype" — a side feature, not the frame.
- A global command input (Home-anchored, ⌘K from anywhere) replaces the old
  palette concept. Without AI it is a router over navigation + deterministic
  actions; with AI, a sentence stages a change into Review. Its form is
  spec'd fresh (`specs/home.md`), not inherited from the removed palette.
- The `Session` surface's activity digest merges into Home's feed rather than
  being its own tab.

### Home: the hub

Home stops being a tile grid and becomes the answer to "what is happening in
my sandbox, and what should I do next?"

1. **Status strip.** Sandbox instance, active branch, persistence mode
   (ephemeral / IDB / `--persist`), deployed rules hash vs repo rules hash
   (drift indicator). No mode indicators — there are no modes (M2).
2. **Agent presence.** Bridge peer connected? MCP session active? Which
   client (from the proxy handshake)? A quiet "● Claude Code connected" chip
   is the single most confidence-building pixel for the target user.
3. **Live activity feed.** The Action Center feed, promoted: writes, denials,
   rule deploys, seeds — provenance-stamped (auth lens / agent vs app), each
   row deep-linking to the doc, denial, or review item it references.
4. **Command bar.** The ⌘K palette inline. Empty state teaches by example:
   three mechanical suggestions ("Seed 20 users", "Simulate a write as
   alice", "Replay traffic against edited rules") that are *buttons into
   forms*, and — when a key is present — the same phrases work as NL.
5. **Routes.** The tile grid survives below the fold as discovery, each tile
   carrying live counts (docs, users, denials) instead of static copy.

First-run (empty sandbox) Home is the onboarding: "connect your agent"
(MCP setup snippet), "seed some data" (mechanical seed builder), "bring your
rules" (repo file detected → deploy to sandbox).

## Mechanical fallback inventory

Each cognitive feature, its deterministic core, and the mechanical UI over it.

| Cognitive feature (Playground/Studio) | Deterministic core | Mechanical UI design |
|---|---|---|
| NL data seeding | `seed_firestore_data_as_admin`, seed-proposal apply | **Seed builder**: pick collection, define fields (type + generator: name/email/int-range/enum/ref), count, write. Plus paste-JSON and import-from-repo-fixture. AI mode: NL box streams a proposal into the same builder for review. |
| Data modeling / discovery | `sandbox_discover_paths`, `firestore_discover` | **Structure view** (in Firestore tab or Home): inferred collection/field tree from live data, exportable as markdown/typed model to repo. AI mode: narrative model critique. |
| Security rules authoring | `pyric/rules` lint/validate/simulate, rules stdlib, `assembleGameRules` | **Rules workbench**: editor with lint-on-type, stdlib snippet picker, deploy-to-sandbox vs save-to-repo. Fully deterministic. AI mode: "draft rules for this structure." |
| Rules simulation | `simulate_firestore_write` | **Simulator form**: operation, path, auth context (pick from real sandbox users), request data → allow/deny with evaluation trace. |
| Denial debugging | `inspect_denial`, `debug_firestore_rules` | The **denial pipeline** (TOOL-SYSTEM.md): denial in Traffic → `DenialDetail` → re-simulate (`Verdict`, parameters editable) → edit rules → `RegressionTable` replay → deploy/save. Each stage renders a result and derives the next action; no standing control heaps (M6). The old `DenialInspector` form is explicitly not the starting point. AI mode: narration + suggested fix over the same pipeline. |
| Rules regression check | `try_rules_edit` (replay captured writes + re-simulate denials) | **"Re-run traffic against edited rules"** button in the workbench: table of captured ops × old verdict × new verdict, regressions highlighted. This is the killer mechanical feature — deterministic, unique to Pyric, needs zero AI. |
| Security/access audit | `firebase-audit` skill (composes read-only tools) | **Coverage matrix**: simulation sweep of discovered paths × operations × representative identities → allow/deny grid. Deterministic. AI mode: narrative findings and prioritization on top of the same matrix. |
| Index derivation | `firestore_extract_indexes` | Button: "derive indexes from rules + observed queries" → diff against repo `firestore.indexes.json`, write back. |
| Fixture generation | `generate_fixture_from_session`, `--capture` | **"Save session as fixture"** in Home/Traffic → writes to repo `fixtures/` via the disk workspace route, with the `pyric verify` command shown. |
| Auth user seeding | `seed_auth_users` | Bulk-create form in Auth tab: count, provider mix, claim templates. |
| Ideas / suggestions / prompt enhancer | none (pure LLM) | No mechanical twin; degrade to a template/example gallery in Build. These stay AI-only and Build-scoped. |
| App building | esbuild-wasm preview compiles hand-written code without AI | Build surface works keyless as a manual editor + preview + deploy; the agent is the enhancement. |

## The repo seam (single source of truth)

`pyric serve --ui` already mounts disk routes: `/__pyric/workspace` and
`/__pyric/projects`, and `init.json` carries `rulesHash`. Design:

- **Rules**: workbench shows three states — repo file, deployed-to-sandbox,
  editor buffer — with explicit actions "Deploy to sandbox" and "Save to
  repo." Drift between repo hash and deployed hash surfaces on Home.
- **Fixtures/seeds**: fixture save and seed-definition export write repo
  files; the seed builder can load them back.
- **Indexes**: extraction diffs against and writes `firestore.indexes.json`.
- **Structure docs**: discovery export writes a markdown data-model doc.

Result: the local coding agent (via MCP + repo files) and Studio (via UI +
the same repo files) stop being two sources of truth.

## The external-agent (MCP) story

- **Presence + feed** (above) make agent work visible with zero new plumbing
  — the event stream already carries it.
- **Governance** (per M7, not the old dial): policy applies only to
  agent-initiated mutations and surfaces where it fires — a blocked or
  staged call appears as a `StagedChange` inline on the affected data, with
  Review as the index. Mechanically, the worker is the right single
  enforcement point: today sandbox-mode forwarded MCP calls are *not*
  gated and the worker's `setPolicy` never reaches the bridge process (two
  disconnected policy stores). The worker executes forwarded tool calls
  (`{t:'tool'}` → `host.ts` dispatcher), so enforcement lands there; the
  policy setting itself lives in Settings, not as ambient chrome.
  *(Decision needed: default policy for MCP writes — allow-with-feed vs
  stage.)*
- **Audit**: the bridge already writes `~/.pyric/projects/<p>/events.ndjson`;
  surface it later as a history view (P3).

## One conversation system: sessions as a Studio primitive

The trap to avoid: Home grows a prompt box with history, while Prototype
keeps the playground's session system — two agent stacks (Studio's assist
harness vs the playground session host), two BYOK stores, two histories,
two tool registries, two model pickers, duplicating every feature and
drifting. That is exactly how the experience falls apart.

Resolution: **there is one session store, one key store, one tool registry,
one history — owned at the Studio level.** A "prototype session" is not a
different kind of conversation; it is a session that has a workspace
(appSource/preview) attached. Sequencing:

- **Near term, Home hosts no chat thread at all.** Its command input stages
  single actions (mechanical always; NL-to-staged-change with a key).
  Conversational agency lives where it genuinely is in local dev — the
  user's external coding agent over MCP — and, for in-browser chat, inside
  Prototype. No duplication because there is only one conversational
  surface.
- **When Studio needs native chat** (the website story), the session host +
  tool registry extract from the playground into a shared package, and both
  Home and Prototype become views over the same session store. History
  management, keys, and model selection are implemented once.

## Architecture: how Prototype integrates without a rewrite

Studio (Vite) and Playground (Astro, static, own base path) stay **separate
builds** through this redesign. Merging frameworks is expensive and blocks
nothing above. What changes is the seam:

1. **Studio owns all chrome.** Embedded (`?embed=studio`) playground hides
   its TopBar already; extend so Studio also owns session switching, and the
   Prototype surface defaults to the `firebase` profile with app-builder
   chrome (ideas/suggestions/deploy sub-tabs, GitHub panels) behind an
   opt-in.
2. **Session lifecycle over postMessage, not page reloads.** Add
   `pyric:playground:new-session`, `open-session {id}`, `list-sessions`,
   and a `pyric:studio:session-changed` echo. The iframe navigates itself;
   Studio never reloads. Sessions already live in IndexedDB, so this is
   protocol work, not storage work.
3. **URL sync.** `/prototype/<sessionId>` in Studio's route codec, kept in
   sync with the echo messages. Deep-linking a session becomes real.
4. **The Firebase Tab dissolves.** It was the only way to visualize sandbox
   data; that is no longer true, so each sub-tab gets a disposition:
   - *Redundant when shared* — Data/RTDB/Auth/Traffic/Sandbox-status
     duplicate Studio's tabs over the same sandbox: hidden when embedded;
     affordances (denial banner etc.) deep-link to Studio tabs via a
     generalized `pyric:studio:navigate {path}` message.
   - *Relocates to Studio* — the Seed sub-tab's concepts fold into Studio's
     mechanical seed builder.
   - *Prototype-specific stays* — Deploy (redesigned around the simplified
     auth below), Ideas/Suggestions (AI-only, prototyping concerns).
   - *Isolated-mode caveat* — an isolated session's sandbox is not the
     shared worker, so Studio tabs can't show it. Near term: shared is the
     default (already true when embedded); isolated becomes an advanced
     option keeping only a minimal inspector. Visualizing isolated
     sandboxes in Studio (multi-sandbox) is explicitly out of scope.

## Deployment auth: one story

GIS-in-the-browser for cloud-scope tokens was a moonshot and is now too
complex; `pyric login` works but demands a user-supplied OAuth client and
secret. Simplify to a single story:

1. **Bundle an OAuth client with `pyric-tools`** so `pyric login` works out
   of the box (PKCE/loopback installed-app flow — the `firebase-tools`
   precedent: installed-app client secrets are not treated as confidential,
   so bundling is normal practice). User-supplied clients remain a
   power-user override.
2. **`pyric serve` becomes the credential broker.** Browser surfaces
   (Studio repo write-back, Prototype deploy) request short-lived tokens
   from the local serve process (e.g. `/__pyric/auth/token`), which holds
   the CLI credentials. The browser never runs its own OAuth dance in local
   dev.
3. **GIS survives only where there is no local serve** — the hosted website
   — and only if the website keeps a deploy story at all (it may not need
   one).

One login (`pyric login`), everything brokers through serve, zero
client/secret setup for the normal path.

Longer term (post-npm, when the website needs a standalone assistant), the
agent core — session host, tool registry, skills — extracts from the
playground into a shared package so Studio can host chat natively. Not
required for this redesign.

### Tool registry convergence (P2)

Three tool surfaces exist: the MCP bridge tools (`pyric-tools`
`tool-metadata.ts`), the playground agent registry
(`playground/src/lib/tools/`), and Studio's proposals-agent tools. They
overlap and drift. Converge on `pyric-tools/registry` as the single
composition consumed by all three, so the triad (tool / mechanical form /
agent) is definitionally in sync, and every new tool automatically reaches
MCP, the browser agent, and (with a small schema-to-form layer) a mechanical
UI.

## Website story

Studio's `DevSeedProvider` already boots a seeded in-page sandbox with no
server — the review build *is* the website build. The site is Studio Home on
a seeded sandbox: visitors click through real denials, run the simulator,
replay traffic, browse data; a BYOK key (or a hosted demo relay) lights up
the command bar. Build (with Ollama as the zero-config local option) is the
"and it can even build apps" epilogue. Blocker: the `@inbrowser/relay@0.4.0`
migration left all Studio AI providers erroring "not wired yet" — the
provider wiring must be restored for any AI-on story.

## Phased plan

**Phase 0 — Foundations (no new surfaces)**
- Design system in force: PRINCIPLES.md, spec workflow, design lint.
- History-API routing (port the hash codec's shape to pathname routes).
- Fix the relay 0.4 provider wiring so Studio AI works at all.
- Registry **parity audit**: mechanically diff playground tools, bridge
  tool metadata, and `pyric-tools/registry` into the exposure matrix;
  classify each gap as defect or deliberate (TOOL-SYSTEM.md, M8).
- Stable event ids + session identity stamped through the event plane
  (prerequisite for addressable traffic and provenance).
- Ship the agent-presence chip + surface the activity feed data on Home
  (form per `specs/home.md`).

**Phase 1 — The hub and the mechanical core (spec-first)**
- `specs/shell.md` + `specs/home.md` implemented: single sacred bar, hub
  with command input, status, feed, live-count tiles, first-run onboarding.
- Traffic rework per `specs/traffic.md`: virtualized, addressable events,
  subject/consequence cross-links, chart demoted to disclosure.
- **Rules design track** — the deepest surface gets its own dedicated
  design effort, not one spec: rules editor, simulator/denial pipeline,
  traffic-replay regression table, coverage sweep — each with its own
  content inventory, designed as compositions of the same result renderers.
- Mechanical seed builder (Firestore + Auth).

**Phase 2 — The Prototype seam**
- Rename playground → Prototype; opt-in app-builder chrome; embedded
  profile defaults to firebase-focused.
- Session lifecycle postMessage protocol + `/prototype/<id>` URL sync; kill
  the reload-to-new-session flow.
- Collapse redundant embedded sub-tabs; generalized `navigate {hash}`
  deep-links into Studio tabs.

**Phase 3 — Convergence and the repo seam**
- Repo write-back for rules / fixtures / indexes / structure docs; drift
  indicators on Home.
- Unify policy enforcement in the worker; MCP proposals into Review.
- Converge the three tool registries on `pyric-tools/registry`.

**Phase 4 — Website / post-npm**
- Publish the seeded-sandbox Studio build as the site.
- Extract the agent core if/when Studio should host chat natively.
- Coverage-matrix audit view; bridge audit-log history view.

## Open decisions

1. **Default MCP write policy** in sandbox mode: silent-with-feed,
   notify, or propose-and-review? (Recommend: allow + feed by default,
   dial available — friction on an already-local sandbox may hurt more
   than it protects.)
2. **Home vs Hub naming** — "Home" recommended; the hub is a behavior,
   not a label.
3. **Does Prototype appear in nav for keyless users?** Recommend yes,
   since preview/editor/deploy work keyless, with copy framing it as
   prototyping.
4. **Dark-only through the redesign?** Recommended yes until post-npm; the
   token system makes theming a later, contained task.
