# HIERARCHY (v2 proposal, for step-3 iteration)

Still a draft to argue with. v2 folds in your correction: pure verbs hide what people search by. A developer thinks in services. They need auth, they need to store a document, they need to put a file somewhere. The nav has to answer that on sight. So the middle of the journey becomes service-shaped, while the frame stays the journey and the leaves stay verbs.

What changed from v1:

- **Build is now service-shaped.** Four doorways a reader recognizes: users, data, realtime data, files. Each is still written as outcomes, but a person scanning for "auth" or "storage" lands immediately.
- **Storage got real outcomes** instead of hiding in the experimental page.
- **The Firestore-vs-RTDB overlap** gets an explicit "which one" page.
- **The agent doorway got concrete.** Not "work with an agent" in the abstract. Set up MCP. Set up Claude Code, Cursor, Codex. Here are the skills.
- **Skills are in, both ways.** As a feature (install them into your agent) and as source knowledge (they teach the behavior and list the Pyric moves). They weave into the service and rules doorways and get a home in the agent section.

The nav is grouped, so each section stays short and scannable.

---

## The left nav, top to bottom

```
GET STARTED
  Start building

BUILD  (what can I do with each service)
  Sign in and manage users            Auth            v1
  Store and query data                Firestore       v1
  Sync realtime data                  Realtime DB     experimental
  Store files                         Storage         experimental
  Which data service should I use?    Firestore vs RTDB

MAKE IT SOLID
  Secure it with rules                Rules           v1
  See what's happening                observability
  Shape your data                     seed/snapshot/reset/replay

SHIP & TEST
  Ship to production                  deploy / verify
  Test in Node                        node / admin

WORK WITH AN AGENT
  Set up your agent                   MCP, Claude Code, Cursor, Codex
  What your agent can do              the tool surface
  Skills                              install + catalog
  Watch and review                    Prototype + events

TRUST
  How we know it matches Firebase     conformance
  What's experimental                 RTDB + Storage, honestly

REFERENCE
  pyric  ·  pyric-admin  ·  pyric-tools
```

Six sections. The services are visible where a person looks for them, under a header that still reads as a verb ("Build"). The cross-cutting behaviors that are not tied to one service stay as their own outcomes. Package names appear once, at the bottom.

---

## GET STARTED

### Start building
**Promise:** a working Firebase backend in one command. No account, no project, no emulator.
- Your backend in one command `[reuse: pyric-tools/tutorials/getting-started]`
- Scaffold a new app `[reuse: init template docs]`
- Add Pyric to an app you already have `[reuse: how-to/use-the-vite-plugin, tutorials/server-adoption]`
- What just happened (the swap, in one page) `[new, short]`
- *And from an agent:* one flag and it can drive this too (teaser to the agent section) `[new, short]`

**Maturity:** core.

---

## BUILD

### Sign in and manage users  (Auth, v1)
**Promise:** sign users in the way your app needs, and shape who they are.
- Sign users in (anonymous, email and password, Google popup and redirect) `[reuse: pyric/auth/reference]` `[new how-to]`
- Manage users in the sandbox (seed users, set claims, switch the current user) `[reuse: auth sandbox driver]` `[new]`
- Design an identity model (UID-to-data, custom claims, roles) `[skill: firebase-auth-model]` `[new from skill]`
- How identity reaches your rules (cross-link to Secure it with rules) `[reuse: sandbox identity explanation]`
- *And from an agent:* design or audit the auth model for you `[skill: firebase-auth-model]`

**Maturity:** v1 and loud. This is where Auth finally gets the how-to and explanation pages it lacks today (it has 5 pages, reference-only).

### Store and query data  (Firestore, v1)
**Promise:** write the Firestore code you know, run it locally, shaped like production.
- Read and write documents `[reuse: firestore/how-to, tutorials]`
- Query your data (where, orderBy, limit, aggregations) `[reuse: firestore/how-to/build-queries]`
- Keep the UI live with onSnapshot `[reuse: firestore/how-to/use-onsnapshot]`
- Run a transaction `[reuse: firestore/how-to/run-a-transaction]`
- Design queries and the indexes they need `[skill: firestore-query-indexes]` `[reuse + skill]`
- *And from an agent:* shape queries and extract indexes `[skill: firestore-query-indexes]`

**Maturity:** v1 and the draw.

### Sync realtime data  (Realtime Database, experimental)
**Promise:** store and sync a live tree of data.
- Store and read realtime data `[reuse: pyric/database docs]`
- Model your RTDB tree (paths, fan-out, denormalized reads, .indexOn) `[skill: rtdb-data-model]` `[new from skill]`
- Validated writes (check shape and rules before writing) `[reuse: rtdb_validated_write]`
- Clearly labeled experimental; links to What's experimental.
- *And from an agent:* model the tree and validate writes `[skill: rtdb-data-model]`

**Maturity:** experimental. Present, useful, honestly marked.

### Store files  (Storage, experimental)
**Promise:** put files in a bucket and get them back, with rules on them.
- Upload and download a file `[reuse: storage/tutorials/upload-and-download]`
- List and delete files `[reuse: storage/how-to/list-and-delete]`
- Round-trip metadata `[reuse: storage/how-to/round-trip-metadata]`
- Enforce storage rules `[reuse: storage/how-to/enforce-rules]`
- Clearly labeled experimental; links to What's experimental.

**Maturity:** experimental. This is the doorway that did not exist before; Storage had no outcome home.

### Which data service should I use?
**Promise:** a straight answer to Firestore versus Realtime Database.
- The one-page decision (query power and structure vs simple low-latency sync) `[new, short]`

**Maturity:** connective. Small but load-bearing, because the overlap is a real question.

---

## MAKE IT SOLID

### Secure it with rules  (Rules, v1)
**Promise:** prove a user can touch only their own data, before you deploy.
- Simulate a request's verdict `[reuse: rules/how-to/simulate-locally]`
- Lint your rules `[reuse: rules/how-to/lint-source]`
- Write a rules test suite `[reuse: rules/tutorials/write-a-test-suite]`
- Read a denial and understand it `[reuse: sandbox denial explanation]`
- Compare two rulesets for weakening `[reuse: rules/how-to/compare-for-weakening]`
- Audit Firestore rules for holes `[skill: firestore-rules-audit]`
- Author and audit RTDB rules `[skill: rtdb-security-rules]`
- Audit the whole project's posture `[skill: firebase-audit]`
- *And from an agent:* simulate before writing, audit on demand `[skills above]`

**Maturity:** v1 and headline. The 28-page rules tree re-hangs here, plus three skills that make it agent-drivable.

### See what's happening  (observability)
**Promise:** watch every read, write, and denial live, with no log lines.
- Watch traffic live in Studio `[reuse: pyric dev --ui]` `[partly new]`
- Read the event stream yourself `[reuse: sandbox/how-to/observe-events]`
- Inspect a denial `[reuse: sandbox/explanation/every-op-is-a-request]`
- Build your own monitor `[reuse: sandbox/tutorials/build-a-traffic-monitor]`

**Maturity:** core.

### Shape your data  (state)
**Promise:** seed, snapshot, reset, and replay the backend like source.
- Seed a scenario `[reuse: sandbox/how-to/seed-data-and-rules]`
- Snapshot it and serve it back `[reuse: pyric snapshot, tools/how-to/promote-to-fixture]`
- Reset between tests `[reuse: sandbox/how-to/reset-between-tests]`
- Replay a captured session `[reuse: sandbox/how-to/replay-events]`
- *And from an agent:* seed and reset as tools `[new, short]`

**Maturity:** core.

---

## SHIP & TEST

### Ship to production
**Promise:** the same code goes live, and you learn what changes before prod does.
- The dev-to-prod build (production keeps real firebase) `[reuse: vite build flavors]`
- Deploy your rules `[reuse: deploy/how-to/deploy-firestore-rules]`
- Deploy indexes from your query shapes `[reuse: deploy/how-to/deploy-indexes]`
- Verify what flips before prod does `[reuse: tools/how-to/verify-against-captured-session]`
- Deploy hosting and functions `[reuse: deploy/how-to/*]`
- Sign in for deploys `[reuse: deploy credential how-tos]`

**Maturity:** core. The 27-page deploy tree re-hangs here.

### Test in Node
**Promise:** the same backend in tests and scripts, no browser, admin shape when needed.
- Test against the sandbox in Node `[reuse: sandbox/tutorials/use-in-a-test-harness]`
- Use the admin shape (one setup line) `[reuse: pyric-admin/firestore tree]`
- Share one backend across app, Node, and agent `[reuse: remote sandbox]` `[partly new]`
- A nod to verify as a testing move (cross-link to Ship) `[reuse]`

**Maturity:** client-in-Node core; admin uneven by service, taught at the seam.

---

## WORK WITH AN AGENT

### Set up your agent
**Promise:** get an agent driving the sandbox in a few minutes, in the tool you already use.
- What MCP gives you here (one bridge, the whole backend) `[reuse: bridge README]`
- Claude Code (the plugin and `pyric-start`) `[reuse: pyric-plugin, tutorials/wire-claude-code]`
- Cursor `[new, short]`
- Codex `[new, short]`
- Any other MCP client `[reuse: bridge docs]`

**Maturity:** core to the story. Per-client recipes are the concrete need you named.

### What your agent can do
**Promise:** the backend as a tool surface, taught by capability not by tool name.
- Read, write, and query as tools `[reuse: agent-tools.md]`
- Simulate rules and run a stateful session `[reuse: firestore_simulator_*]`
- Inspect and discover what exists `[reuse: sandbox_inspect, discover]`
- Deploy over REST `[reuse: deploy tools]`

**Maturity:** core, newest ground; honest that the surface is wide and consolidating.

### Skills
**Promise:** teach your agent to do the hard Firebase things right, with Pyric.
- What a skill is and how to install it `[reuse: .agents/skills, pyric-plugin/skills]`
- The catalog: auth models, query and index design, Firestore rules audits, RTDB data models, RTDB rules, whole-project audits `[reuse: the six domain skills]`

**Maturity:** core. Each skill also links back to the service or rules doorway it serves.

### Watch and review
**Promise:** see what the agent did and check it.
- The Prototype console `[reuse: studio Prototype]` `[partly new]`
- Review through the event stream `[reuse: sandbox events]`

**Maturity:** core.

---

## TRUST

### How we know it matches Firebase  (conformance doorway)
**Promise:** the "behaves like Firebase" claim is tested, not asserted, and here is the receipt.
- The claim and how it is proven (oracle, observations, CI replay) `[reuse: docs/conformance/how-to-run-the-conformance-system]`
- Read the compatibility matrices (into Reference) `[reuse: COMPAT set]`
- What a divergence means `[new, short]`

### What's experimental
**Promise:** one honest page on what is not yet v1.
- Realtime Database: what works, what does not, why `[reuse: database COMPAT]`
- Storage: same `[reuse: storage COMPAT]`
- What experimental costs you, and when it graduates `[new, short]`

---

## REFERENCE  (the one noun section)
Per package, for the reader who already knows what they want.
- **pyric** — Web SDK (firestore, auth, database, storage), sandbox runtime, rules engine, COMPAT matrices. `[reuse: reference/* + feature-matrix + COMPAT]`
- **pyric-admin** — admin surface and the sandbox/prod seam. `[reuse: pyric-admin reference]`
- **pyric-tools** — CLI, deploy API, MCP tool catalog. `[reuse: cli.md, deploy reference, agent-tools.md]`

`@pyric/ui` keeps its own component docs, out of scope here.

---

## Skills, mapped

Each domain skill is content twice: a feature you install, and knowledge a human page draws from. Where each lands:

| Skill | Serves doorway | As feature | As source for the page |
|---|---|---|---|
| `firebase-auth-model` | Sign in and manage users | "your agent can design your identity model" | Design an identity model |
| `firestore-query-indexes` | Store and query data / Ship | "your agent shapes queries and indexes" | Design queries and the indexes they need |
| `firestore-rules-audit` | Secure it with rules | "your agent audits rules" | Audit Firestore rules for holes |
| `rtdb-security-rules` | Secure it with rules | "your agent authors RTDB rules" | Author and audit RTDB rules |
| `rtdb-data-model` | Sync realtime data | "your agent models the tree" | Model your RTDB tree |
| `firebase-audit` | Secure it with rules | "your agent audits the whole project" | Audit the whole project's posture |

Internal-only skills, not user product docs: `writing-documentation-with-diataxis` (we use it to write these pages in step 4), `readme-bookstore-test`, `playground-prompts`.

---

## What changes mechanically

Same two options as v1. Recommendation unchanged: re-map the generator's nav plan (`packages/site-docs/scripts/port-content.ts` `GROUPS`) to hang existing slugs under the new doorways, then write the `[new]` pages. The prose is good; the shelving is the problem. The new writing is bounded: Auth how-tos, the four Storage and RTDB outcome pages, the "which data service" and "what just happened" connective pages, the per-client agent setup recipes, the skills catalog page, and the short "and from an agent" notes. The six domain skills are drafts of six of those pages already.

---

## Open for iteration

- **Grouping headers.** GET STARTED / BUILD / MAKE IT SOLID / SHIP & TEST / WORK WITH AN AGENT / TRUST / REFERENCE. Right labels, right order?
- **Storage and RTDB placement.** In BUILD with an experimental tag, as drafted. Or held out of BUILD until they graduate, with only the What's experimental page? You leaned toward the honest label, this follows that.
- **The agent section's size.** Four doorways. Is "Watch and review" its own page or a section of "What your agent can do"?
- **Skills: catalog page vs woven only.** Drafted as both a catalog page and per-doorway callouts. Too much surface, or right?
- **Auth vs Firestore order in BUILD.** Auth is the gate, Firestore is the draw. Which comes first?
- **"Which data service" page.** Standalone entry, or a section inside "Store and query data"?
