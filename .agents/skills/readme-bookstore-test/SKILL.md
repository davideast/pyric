---
name: readme-bookstore-test
description: Generates and iterates a README that earns the reader's attention progressively (cover → inner flap → reading the book), then verifies every claim and example against the real artifact. Use when writing or reviewing a README or landing page for a library or tool. Includes an iteration ratchet - corrections made during review are captured as general principles, not one-off edits.
---

# README — The Bookstore Test

Write a README the way a person decides to buy a book: they glance at the
**cover**, read the **inner flap**, then commit to **reading the book**. The
README must earn the reader's attention at each stage before asking for more
of it.

This skill runs in four phases: **Draft → Verify → Iterate → Ratchet.**
The draft is cheap; the verification is the product. A README is a set of
claims, and unverified claims rot.

---

## Phase 1 — Draft

### The Cover

Open with a single sentence that states what problem this library solves —
not what the library *is*, and not the product it belongs to. The reader
should recognize their own situation. No taglines, no badges, no logos.

**Good:** "Coordinate multiple coding agent sessions across a repository and
merge their pull requests sequentially."
**Bad:** "Jules Fleet is a powerful orchestration framework built on the
Jules platform for enterprise-grade AI agent management."

### The Inner Flap

Immediately show the library in use. Code speaks louder than descriptions.
Show the **primary workflow** in a single, copy-pasteable example, then one
or two **secondary workflows** that reveal depth.

- **No setup first.** Don't open with installation, auth, or configuration.
  The reader hasn't decided to use the library yet.
- **Anchor in the reader's existing habit.** If the library mirrors,
  replaces, or extends something the reader already knows, the first example
  should read like the thing they already write — with the delta made
  explicit ("the one line that differs is…"). The fastest route to "I get
  it" is recognition plus one visible change, not novelty.
- **Straightforward language.** Describe what the code does, not how
  impressive it is. Never "powerful", "seamless", "robust",
  "enterprise-grade", "cutting-edge".
- **Working examples.** Valid, runnable code — no pseudocode, no `// ...`
  elisions.
- **Progressive complexity.** Simplest useful invocation first, then one
  advanced case that reveals a second capability.

### Reading the Book

Now the reader is committed. Document the full top-level API — every
command, function, or option a user would reach for. Comprehensive in
scope, concise in explanation. Structure as **reference**, not tutorial:
what it does (one line), minimal usage, options as a table or list. Setup,
auth, and configuration go here — after the reader has decided.

### Tone

Write like a colleague explaining their work to another engineer. Direct
and specific. Don't sell — inform. If a feature has limitations, state
them as facts with pointers to where they're tracked, not as hedges. Trust
earns more adoption than marketing.

### Vocabulary

- One name per concept, used consistently from the first mention. If the
  project has internal codenames or a domain glossary, either define a term
  on first use or don't use it.
- Freeze the vocabulary before you publish it. If a rename is already
  planned, write the new name or delay the section — never document a name
  scheduled to die.
- Give the reader the parent term before the precise ones. Readers need one
  broad word for the whole apparatus before they can absorb the taxonomy
  beneath it.

---

## Phase 2 — Verify (the phase that isn't optional)

Every README is a set of claims. Before publishing, verify each class:

1. **Execute every command.** Run each shell command in the README exactly
   as written, in a fresh directory. A command transcribed from a source
   file's comment or your memory is a guess, not a fact — tooling entries
   go missing, flags drift, scripts get renamed.
2. **Run every example against the installed artifact.** Examples must be
   validated against what the reader will actually have — the packed
   tarball or published package installed into a clean consumer project —
   not against the source tree. Source trees resolve imports and carry
   state that installed packages don't.
3. **Match every claim to its evidence tier.** State only what the
   project's tests or documentation system actually back. "Compatible
   with X" is a different claim from "mirrors X's behavior, verified
   against captures of X" — write the one that's true, and link to the
   proof rather than substituting adjectives for it. Receipts beat
   superlatives.
4. **Treat hand-maintained lists as drift debt.** Any README table that
   mirrors machine truth — exported subpaths, commands, option lists —
   WILL drift from the source of truth. Either generate it from that
   source, add a mechanical check that diffs it, or replace it with a link
   to generated reference docs. If none of those, consciously accept the
   debt and note where the truth lives.
5. **State the stability contract explicitly.** Version, maturity (alpha /
   beta / stable), what is promised and what may change — in plain words,
   near the top of Reading the Book. An experimental product loses nothing
   by saying so and loses everything by being discovered to be.

---

## Phase 3 — Iterate

Generate the draft, then hand it to the human owner for nuance. Expect
corrections — the owner holds context the generator doesn't (positioning,
audience, history). Apply corrections faithfully. Do not defend the draft.

---

## Phase 4 — Ratchet (how this skill improves)

After each iteration session, for every correction the human made, ask:
**"What is the general principle behind this correction — stated so it
applies to any library, not this one?"** Append the answer to the Learned
Principles section below, dated. Corrections that are genuinely one-off
(taste, positioning specific to this product) are applied but not recorded.

This is the ratchet: the skill accumulates judgment; the next first draft
starts where the last iteration ended.

### Learned Principles

- **2026-07-08 — Commands rot silently.** A documented command referenced a
  tool whose runner entry was never wired up; nothing failed until the
  command was executed during fact-checking. Principle: executing every
  documented command is the cheapest bug-finder a docs pass has — Phase 2.1
  exists because transcription is not verification.
- **2026-07-08 — Surface tables drift.** Hand-maintained API/subpath tables
  in shipped READMEs were missing a meaningful fraction of real exports,
  unnoticed for months, because nothing checked them. Principle: Phase 2.4 —
  generate, check, link, or consciously accept.
- **2026-07-08 — Recognition beats explanation.** The strongest first
  example for a mirror-style product was the upstream product's own
  canonical snippet with exactly one changed line, and the gap that broke
  that snippet was the product's highest-priority bug. Principle: the inner
  flap's first example should be the reader's existing muscle memory plus a
  visible delta (Phase 1, "anchor in the reader's existing habit").
- **2026-07-08 — Claims need a tier, not an adjective.** "Verified against
  production behavior" and "believed correct from documentation" are
  different claims that both hide behind "compatible". Principle: Phase 2.3
  — write the claim at the strength the evidence supports and link the
  evidence.
- **2026-07-08 — Narrative before inventory.** A structurally correct,
  fully verified draft was rejected because it read like a manual: it
  documented the codebase instead of telling the reader what their life
  looks like with the product. The reader's test is "oh, I could use this
  for…" — every section must serve self-interest woven into a story
  (the problem's real cost, the one-command relief, what the reader keeps).
  A README is not a repo autobiography; put the story ahead of the API and
  let the reference material live in linked docs.
- **2026-07-08 — For invisible-by-design products, the product's API is
  the wrong hero.** When a product's ideal usage hides it (a dev-time
  layer, a wrapper, a runner), most users never import it — so the primary
  example must show the user's UNCHANGED world plus the one command that
  adds the product, and the product's own API belongs in a "when you want
  explicit control" section near the end. Recognition-plus-delta (an
  earlier principle) was necessary but insufficient: the delta for these
  products is a command, not a changed import.
- **2026-07-08 — Position as AND, not VS.** If the product complements an
  incumbent rather than replacing it, say so explicitly and early ("X
  during development, incumbent in production") — otherwise the reader
  manufactures a migration decision the product never asks them to make,
  and declines it.
- **2026-07-08 — Show uniqueness, never declare it.** "Nothing else does
  this" is pretentious and unfalsifiable; a concrete list of capabilities
  the reader has never had (with what each one is FOR) makes the same
  point and survives skepticism. Related: capabilities are supporting
  cast — name the protagonist (the core primitive that makes them
  possible) and attach every capability to it, rather than presenting a
  flat feature list.
- **2026-07-08 — Name the tax.** The strongest problem statement
  enumerates the incumbent's real setup/friction cost concretely (logins,
  installs, config wiring), then contrasts it with the product's single
  step. Specific friction is recognizable; abstract friction ("it's hard
  to get started") is not.
- **2026-07-08 — Enthusiasm spends trust; facts earn it.** A draft was
  rejected for tone: celebratory interjections ("That's it"), speed/power
  adverbs ("at full speed"), and grammatical flourishes trip the reader's
  bullshit meter, and each one undermines the technical merit it decorates.
  Plain declarative sentences and plain punctuation (no em dashes, no
  exclamations). If the product pioneered a category, the reader must reach
  that conclusion themselves; stating it, or writing like it, prevents them.
- **2026-07-08 — A list of things the product is NOT is a pitch, not
  information.** "No account, no project, no config" reads as selling and
  adds confusion. State what the one step does; let the absent steps be
  conspicuous by their absence in the enumerated incumbent tax.
- **2026-07-08 — Don't write the reader as an owner.** "Your app boots"
  assumes adoption the reader hasn't granted. Describe the app, the
  session, the workflow in neutral terms until the reader has actually
  made something theirs.
- **2026-07-08 — Headings carry the story.** Label headings ("Features",
  "What the agent can do now") stall the narrative; each heading should be
  a step in the reader's journey ("Starting a project", "Work that carries
  to production"). Read the headings alone: they should summarize the
  story.
- **2026-07-08 — Foreground what only this product does; commodity
  integrations get one flat sentence.** A draft undersold the genuinely
  novel capabilities (in this case rules-as-a-library, denial inspection,
  index extraction, session replay) while presenting a now-commonplace
  integration (an editor/agent plugin) as a selling point. Inventory the
  capabilities that exist nowhere else and give them the narrative space;
  mention table-stakes integrations without ceremony.
- **2026-07-08 — Don't showcase code that isn't the product's.** A
  mirror/wrapper product's README spent its examples on the upstream SDK's
  API, which demonstrates the incumbent, not the product. Code examples
  should exercise the product's own novel surfaces; the "your code is
  unchanged" exhibit needs only a sentence or a short fragment, not the
  spotlight.
- **2026-07-08 — Build a capability census before drafting, and diff the
  draft against it.** Across three rounds the same omission recurred: the
  product's unique tools were repeatedly left out or reduced to a link,
  because the draft was written from the narrative downward instead of
  from the product's own inventory upward. Before Phase 1: enumerate the
  capabilities from the repo's own inventories (tool lists, exports,
  docs), and for each one decide include-by-name or consciously exclude.
  A capability the owner considers core that appears zero times is a
  failed draft regardless of prose quality.
- **2026-07-08 — Name the architectural spine.** Features presented as a
  flat list undersell; the primitive that unifies them (here, a typed
  event stream every diagnostic consumes) gives the reader the model that
  makes each feature legible and the whole feel designed. Find the one
  sentence of architecture that explains the most features and spend it.
- **2026-07-08 — Describe tools from their source descriptions, not their
  names.** A tool's name suggests less (or different) than what it does;
  the source's own description field is the verified claim. Paraphrase
  it, don't infer from the identifier.
- **2026-07-08 — No manual line wrapping in markdown prose.** One line
  per paragraph; hard-wrapped prose is a diff and editing nuisance and an
  owner correction that should never recur.
- **2026-07-27 — Make generator freshness explicit.** An unversioned package-generator command can reuse stale package-runner state and silently expose an older template set. User-facing onboarding commands should request the intended distribution tag explicitly, such as `npm create package@latest`; internal package identity, usage syntax, and implementation comments can remain unversioned.

---

## Anti-patterns

| Anti-pattern | Why it fails |
| :--- | :--- |
| Leading with badges, logos, or status shields | Visual noise before the reader knows what the library does |
| "Getting Started" as the first section | Forces setup before demonstrating value |
| Feature bullet lists without code | Tells instead of shows — the reader can't evaluate the API |
| "Easy to use", "simple", "just works" | Self-congratulatory claims that invite skepticism |
| Long install/config blocks before any usage | Asks for investment before demonstrating return |
| Collapsible sections hiding core API docs | Buries the content committed readers came for |
| Unexecuted commands and untested examples | The README becomes the first place the product breaks |
| Adjectives where evidence should be | "Robust" is a claim with no falsifier; a linked test count is one |
| Documenting names scheduled for renaming | Ships vocabulary that contradicts the next release |

## Checklist

Before publishing, verify:

- [ ] Can a reader understand what the library does in under 10 seconds?
- [ ] Is there a runnable code example within the first scroll?
- [ ] Does the first example anchor in something the reader already knows,
      with the delta explicit?
- [ ] Does setup/config appear *after* the first code example?
- [ ] Has every shell command been executed as written, in a fresh
      directory?
- [ ] Has every code example been run against the installed package (not
      the source tree)?
- [ ] Is every factual claim written at the strength its evidence supports,
      with a link to the evidence?
- [ ] Are all hand-maintained lists generated, mechanically checked, or
      consciously accepted as drift debt?
- [ ] Is the stability contract (version, maturity, what may change) stated
      plainly?
- [ ] Is the language descriptive rather than promotional?
- [ ] Does the reference section cover every top-level API entry?
- [ ] Were this iteration's corrections generalized into Learned Principles?
