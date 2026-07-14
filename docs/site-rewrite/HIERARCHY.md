# HIERARCHY (v3 proposal, for step-3 iteration)

Canonical draft. Supersedes v2. Still ours to argue with.

## What changed from v2

Your four calls, plus the novelty research, reshaped it:

- **A narrative overview page opens the docs.** Not titled "What is Pyric." The page IS the narrative, a concise read that explains what this is and what you get. It leads with "build your thing and get it right," and lets the deeper why reveal itself.
- **Rules became a wing, not a doorway.** It now holds the engine, the standard library, the patterns, the limits that actually bite, verdict-stream debugging, and the auditing skills. The standard library lives inside the wing for now; we reconsider after the first pass.
- **The gallery is a layer, not the front.** Most people do not know rules are brutally hard for games, and they do not care. They want their thing done well. So "What's possible" sits deep in the rules wing, where the Firebase-literate find it and are impressed, and where it never blocks the person just trying to ship.
- **`PATTERNS.md` becomes first-class content**, ported from firebase-agent-sdk and written up, because the standard library already leans on it.
- **The knowledge assets finally have a home** (in the rules wing), so the best material Pyric has stops living only in source.

The governing frame did not change. Outcomes first, service-shaped where people search by service, the agent as the ambient second reader, nouns only in Reference at the bottom.

---

## The left nav, top to bottom

```
Overview                              (the narrative page)

GET STARTED
  Start building

BUILD
  Sign in and manage users            Auth            v1
  Store and query data                Firestore       v1
  Sync realtime data                  Realtime DB     experimental
  Store files                         Storage         experimental
  Which data service should I use?

SECURE & DEBUG  (the rules wing)
  Secure it with rules                overview
  Simulate and lint before you deploy
  Write a rules test suite
  Read a denial and understand it
  The rules standard library
  Rules patterns
  The limits that actually bite
  Audit your rules and data
  What's possible                     (the gallery)

OBSERVE & SHAPE
  See what's happening
  Shape your data

SHIP & TEST
  Ship to production
  Test in Node

WORK WITH AN AGENT
  Set up your agent                   MCP, Claude Code, Cursor, Codex
  What your agent can do
  Skills
  Watch and review

TRUST
  How we know it matches Firebase
  What's experimental

REFERENCE
  pyric  ·  pyric-admin  ·  @pyric/cli
```

---

## Overview  (the narrative page)

Not a table of contents. A short, well-written read that a person finishes knowing what this is and why they want it. The shape, in beats:

1. **What it is, in a breath.** Firebase that runs in your browser. Your `firebase/*` code runs against a local backend in dev and real Firebase in prod, unchanged.
2. **The hook.** One command, no account, no project, no emulator. A full Firebase stack in the first ten seconds.
3. **What you build with it.** Real auth, real data, real rules, seen working locally, then shipped.
4. **The quiet why, for whoever keeps reading.** It focuses on the hard parts. It knows the things about Firebase that are not written down, and it hands them to you and your agent as tools, so the hard thing starts on the far side of the hard part. Forward-deployed expertise, in your own words, never a brag.

Leads reader-first. The person who just wants to ship gets everything they need in the first two beats. The person who keeps reading discovers the depth. `[new; draws from NOVELTY.md, kept concise and humble]`

**Title options to pick from:** "Overview," "The short version," "What you get," "Start here." Not "What is Pyric."

---

## GET STARTED

### Start building
**Promise:** a working Firebase backend in one command. No account, no project, no emulator.
- Your backend in one command `[reuse: @pyric/cli/tutorials/getting-started]`
- Scaffold a new app `[reuse: init template docs]`
- Add Pyric to an app you already have `[reuse: how-to/use-the-vite-plugin, tutorials/server-adoption]`
- What just happened (the swap, one page) `[new, short]`
- *And from an agent:* one flag and it can drive this too `[new, short]`

---

## BUILD

Service-shaped, so a person searching for auth or storage lands on sight. Each is written as outcomes. Detail carried from v2; unchanged except the agent notes now name the specific tool or skill.

- **Sign in and manage users** (Auth, v1). Sign users in; manage users in the sandbox; design an identity model `[skill: firebase-auth-model]`; how identity reaches your rules. Auth finally earns real how-to and explanation pages.
- **Store and query data** (Firestore, v1). Read and write; query; live snapshots; transactions; design queries and the indexes they need `[skill: firestore-query-indexes]`.
- **Sync realtime data** (RTDB, experimental). Store and read; model the tree `[skill: rtdb-data-model]`; validated writes. Labeled experimental.
- **Store files** (Storage, experimental). Upload and download; list and delete; metadata; enforce storage rules. Labeled experimental.
- **Which data service should I use?** The one-page Firestore-vs-RTDB answer.

---

## SECURE & DEBUG  (the rules wing)

This is the wing the novelty research demanded. It is the strongest thing Pyric does, and it gets the room. It is not a lecture on rules. It is "get your rules right, prove it, and debug them with precision," with the depth waiting for whoever needs it.

### Secure it with rules  (wing overview)
**Promise:** prove a user can touch only their own data, before you deploy.
The landing that orients the wing and shows the core loop: write, simulate, see the verdict, deploy. `[reuse: pyric/rules overview]`

### Simulate and lint before you deploy
**Promise:** catch the error before Firebase gives you an opaque 400 or 403.
- Simulate a request's verdict `[reuse: rules/how-to/simulate-locally]`
- Lint your rules `[reuse: rules/how-to/lint-source]`
- The linter catches JS-in-rules mistakes and the real limits (short, points to "the limits that actually bite") `[new from linter, hallucination detector]`

### Write a rules test suite
**Promise:** rules you can trust because they are tested, in-process and in CI.
- `[reuse: rules/tutorials/write-a-test-suite, how-to/test-against-firebase-rules-test-api]`

### Read a denial and understand it
**Promise:** never debug a bare permission-denied again.
- The verdict on every operation, with the rule and data that decided it `[reuse: sandbox denial explanation + event stream]`
- Compare two rulesets for weakening `[reuse: rules/how-to/compare-for-weakening]`

### The rules standard library
**Promise:** reusable, tested rule building blocks, and an import the rules language does not have.
- What the standard library is, and `import { isMyTurn } from 'turns'` `[reuse: STDLIB.md, stdlib-modules.ts]`
- The modules that break the "you can't do that in rules" assumptions: rate-limiting (`timing`), cross-document batch integrity (`atomic`), state machines (`transitions`), membership and spaces `[new from stdlib]`
- Inside the wing for now; revisit whether it earns top-level presence after the first pass.

### Rules patterns
**Promise:** the techniques the hard rules are built from.
- Config document, path blocking, piece-type-agnostic lookup, unique gates, and the rest `[new: port PATTERNS.md from firebase-agent-sdk, write up as first-class content]`

### The limits that actually bite
**Promise:** the Firestore rules limits Google does not document, so your rules compile the first time.
- Source size, chain depth, let bindings, get() count, and the non-deterministic runtime budget with its flaky zone `[new from linter thresholds, LINTER_SPEC]`
- Why the emulator does not save you here `[new from retrospective]`

### Audit your rules and data
**Promise:** find the holes before someone else does.
- Audit Firestore rules `[skill: firestore-rules-audit]`
- Author and audit RTDB rules `[skill: rtdb-security-rules]`
- Audit the whole project's posture `[skill: firebase-audit]`
- *And from an agent:* all three, on demand.

### What's possible  (the gallery)
**Promise:** proof, for the reader who thinks the claims are too big.
- Chess, checkers, connect four, US tax code, and a live tic-tac-toe, all in pure rules `[new: firebase-agent-sdk/examples]`
- Framed as what the tools make an agent capable of, not as the hero. Deep in the wing on purpose. The person shipping a CRUD app never has to see it; the Firebase nerd finds it and is impressed.

---

## OBSERVE & SHAPE

### See what's happening
**Promise:** watch every read, write, and denial live, no log lines.
- Watch traffic live in Studio; read the event stream yourself; inspect a denial; build your own monitor `[reuse: sandbox observe/traffic]`

### Shape your data
**Promise:** seed, snapshot, reset, and replay the backend like source.
- Seed a scenario; snapshot and serve it back; reset between tests; replay a captured session; switch users `[reuse: sandbox state how-tos, pyric snapshot]`
- *And from an agent:* seed and reset as tools.

---

## SHIP & TEST

### Ship to production
**Promise:** the same code goes live, and you learn what changes before prod does.
- The dev-to-prod build; deploy rules; deploy indexes from your query shapes; verify what flips before prod does; deploy hosting and functions; sign in for deploys `[reuse: deploy tree, verify]`
- Set up the project itself: enable auth providers, authorize OAuth domains, provision database and storage `[new from control-plane research]`

### Test in Node
**Promise:** the same backend in tests and scripts, no browser, admin shape when needed.
- Test against the sandbox in Node; use the admin shape (one line); share one backend across app, Node, and agent; a nod to verify `[reuse: sandbox test harness, pyric-admin]`

---

## WORK WITH AN AGENT

The agent is the ambient second reader everywhere, and this is its home. Every "and from an agent" note across the docs points here.

- **Set up your agent.** What MCP gives you; Claude Code (the plugin and `pyric-start`); Cursor; Codex; any MCP client `[reuse: bridge, wire-claude-code, pyric-plugin]`
- **What your agent can do.** The backend as a tool surface, by capability: read/write/query, simulate rules, run a stateful session, inspect, and discover `[reuse: agent-tools.md]`
- **Skills.** What a skill is, how to install it, and the catalog: auth models, query and index design, rules audits, RTDB data models, RTDB rules, whole-project audits `[reuse: .agents/skills, pyric-plugin/skills]`
- **Watch and review.** The Prototype console and the event stream `[reuse: studio Prototype, events]`

---

## TRUST

- **How we know it matches Firebase.** The claim and how it is proven: oracle observations, CI replay, the rules parity harness against the live Rules Test API. What a divergence means `[reuse: conformance docs, corrected to include rules parity]`
- **What's experimental.** One honest page: Realtime Database, Storage, what experimental costs you, and when it graduates `[reuse: COMPAT headers]`

---

## REFERENCE  (the one noun section)
Per package, for the reader who already knows what they want.
- **pyric** — Web SDK, sandbox runtime, rules engine, COMPAT matrices.
- **pyric-admin** — admin-shaped sandbox surface and activation seam.
- **@pyric/cli** — sandbox CLI, artifact and verification APIs, MCP tool catalog.

`@pyric/ui` keeps its own component docs, out of scope here.

---

## The writing debt, now that the wing is real

Re-shelving existing prose covers a lot, but the rules wing and the overview carry most of the new writing. Bounded and specific:

- The **Overview** narrative page.
- The rules wing's new pages: the standard library writeup, **the ported and written-up PATTERNS.md**, "the limits that actually bite," and the linter/denial connective tissue.
- The **gallery** page (mostly curation of existing examples).
- **Auth** how-to and explanation pages (v1 but thin today).
- The **Storage and RTDB** outcome pages.
- The per-client **agent setup** recipes and the **skills catalog**.
- The **project-setup** (enablement) pages under Ship.
- The short **"and from an agent"** notes, each naming a specific tool. Six domain skills are first drafts of six of these.

---

## Still open (small now)

- After the first pass: does the standard library graduate out of the rules wing to its own top-level presence?
- Overview page title (options listed above).
- Grouping-header labels: GET STARTED / BUILD / SECURE & DEBUG / OBSERVE & SHAPE / SHIP & TEST / WORK WITH AN AGENT / TRUST / REFERENCE. Right words?
- Does "Set up the project itself" (enablement) belong under Ship, or does it want its own small doorway given how much the control plane can do?
