# NOVELTY

The mirror is not the story. The mirror is how you get in the door. The story is what is waiting on the other side of it.

I under-sold this in the first pass. I framed Pyric as "Firebase that runs locally," which is true and which is table stakes. The real claim is bigger and it took the chess log and the rules standard library to see it. Pyric knows more about Firebase than the documentation does, and it hands that knowledge to an agent as tools. That is the thing no one else has.

This document is the evidence for that claim, and the narrative it implies. Two research threads are still running and will sharpen the control-plane and introspection sections. The spine below is already load-bearing.

---

## The three layers

Pyric is three layers stacked, and the novelty grows as you go down.

**Layer one, the substrate.** A Firebase-shaped SDK and an in-process sandbox that behaves like the real thing. This is the mirror. It is genuinely useful and it is the part that is easy to explain. It is also the least novel part, because "run a local backend" is a category people already understand.

**Layer two, the instruments.** Tools that do not exist in Firebase's own toolchain. A rules engine you can call as a library. A rules standard library with an import system the rules language itself does not have. Index extraction from source. Schema discovery from a live database. A typed event for every operation, carrying its own rules verdict. A replay that tells you which operations change verdict under new rules. These are not conveniences. They are new capabilities.

**Layer three, the knowledge.** The hard-won Firebase expertise baked into the instruments. The empirical limits of the rules compiler. The patterns that make impossible things possible. A library of rule modules that each refute a "you cannot do that in rules" assumption. Recorded observations of how production Firebase actually behaves, which is knowledge the docs do not fully state.

The layers compound. That is the whole point. An agent standing on all three can do things a raw model cannot.

---

## The proof, first

Two artifacts settle the argument before any feature list.

### Full chess, in pure Firestore security rules, deployed to production

The chess log (`firebase-agent-sdk/plans/chess-implementation-log.md`) is a session where the tools were used to implement complete chess as Firestore security rules. Not the game logic in the app. The rules. Move geometry, path blocking, check detection across sixteen pieces, pins, castling, en passant, checkmate claims. Seventeen tests, all passing, against production Firestore.

Getting there meant discovering, by iteration, the empirical limits of the rules engine that appear in no Firebase documentation anywhere:

- The practical compilation ceiling is around twenty-four to thirty kilobytes. Chess compiles at 24.8.
- About twenty-five functions per match. Thirty-one failed.
- About ten `let` bindings per function. Thirteen failed to compile.
- Shared rule gates exhaust a cross-rule expression budget, so each rule needs a unique first expression that fails fast for non-matching writes.
- A config document over roughly forty thousand index entries fails to write.

A model does not know these limits. It cannot know them, because they were never written down. Pyric is how they were found, and Pyric is where they now live.

### A rules standard library that refutes "you cannot do that"

`packages/pyric/src/rules/modules/stdlib/` is a Firestore Security Rules Standard Library. Fifteen modules, each with rules and executed tests, most verified against production, not just simulated. It is exactly the thing Firebase does not have.

A few of them quietly break rules folklore:

- **`timing`** does cooldowns and rate limiting in rules. The manifest notes it "refutes the rules-cannot-rate-limit assumption," verified against the production engine.
- **`atomic`** enforces cross-document integrity across a batch write using the `get()`/`getAfter()` pair, so a write is valid only if a companion write happened in the same batch. Verified against a real database.
- **`transitions`** enforces state machines. **`membership`** and **`spaces`** do role-based and cross-document access control. **`joining`** does self-service join and leave with no privilege escalation, set-equality checked.

And you compose them with an import the rules language cannot do on its own. `import { isMyTurn } from 'turns'`. Firebase rules have no module system. Pyric added one and calls it the 2+modules extension. A writer, or an agent, assembles a real ruleset from tested parts.

---

## Layer two, the instruments (what does not exist elsewhere)

A catalog of the capabilities that are novel, not mirrored. Each of these is a reason someone reaches for Pyric that has nothing to do with "avoid a live project."

- **The rules engine as a library (`pyric/rules`).** Firebase gives you a deploy target and an emulator. Pyric gives you a parser, a linter, a validator, a simulator, and a Rules Test API client you can call in-process, in CI, and from an agent. Ask whether a specific request would be allowed for a specific user, and get the verdict with the exact rule and data that decided it.

- **The rules standard library and 2+modules.** Covered above. Reusable, tested rule building blocks plus an import system the language lacks.

- **Index extraction from source (`firestore_extract_indexes`).** Reads your `query(collection, where, orderBy)` call sites and derives the `firestore.indexes.json` they require. It even reads JSDoc annotations to prune impossible combinations: `@firestore-mutex` for fields that never coexist, `@firestore-required` for fields always present, `@firestore-budget` as a soft cap. No one hand-maintains an index file with this.

- **Schema discovery from a live database (`firestore_discover_paths`, `firestore_find_collection_group`).** Crawl a real Firestore and infer its shape. Firebase has no "tell me the schema" because Firestore has no schema. Pyric infers one.

- **RTDB structure crawl (`rtdb_crawl_structure`) and validated writes (`rtdb_validated_write`).** Crawl the tree, and before a write, infer the schema at the target path, validate the payload against it, and simulate the rules verdict, all before committing.

- **The 2+modules mechanics, worth spelling out.** A rules file declares `rules_version = '2+modules'` instead of `'2'`. The resolver parses it, reads the `import { isMyTurn } from 'turns'` statements the extended grammar allows, name-mangles every private helper so modules cannot collide, pulls in transitive dependencies, orders them, flattens everything into one function list, and rewrites the version back to `'2'`. The output is byte-valid stock Firestore rules. Firebase never sees the module system. Pyric added an import system to a language that has none, and hides it before deploy.

- **Sandbox events.** Every operation the backend performs is a typed event, including the rules verdict, and for a denial, the rule and data that produced it. This is the substrate under debugging, traffic inspection, and verification. Firebase gives you a `permission-denied` string. Pyric gives you the reason.

- **`sandbox_inspect`, the missing-tool tax made concrete.** One call returns the current rules, a lint summary, a document census, and the recent denials and requests from the event log. Its own header records why it exists: a debug session that diagnosing "why aren't my rules working" once took fifty-one tool calls and seventy-two thousand tokens of grepping node_modules. Now it is one call. That number is the product in miniature.

- **Schema discovery that respects cost (`firestore_discover_paths`, `firestore_find_collection_group`).** Firestore has no schema and no "describe database." Discovery reconstructs one by sampling, cost-bounded and cost-reported, with continuation tokens for large databases and an adaptive early-exit. The crawler notes its BFS strategy was chosen empirically, thirty-eight times faster than serial DFS on a real corpus. Finding a collection group carries a statistical coverage contract, a coupon-collector bound on how many samples cover all parents. This is real engineering, not a wrapper.

- **Replay, for Firestore and RTDB, from real usage.** This is the one I most understated. `pyric dev` captures a session of real operations, real identities, real server timestamps, real auto-ids. Replay re-issues them against a candidate ruleset and tells you which operations change verdict, with sentinel and time fidelity so a re-resolved `serverTimestamp()` is not mistaken for a change, and auto-id aliasing so a fresh id is not either. The RTDB path rewinds prior state so each write replays against what it originally saw. This is a rules-regression harness generated from observed behavior, not hand-written tests. And `pyric verify` in its "both engines" mode runs the same cases through the local sandbox and the hosted Firebase Rules Test API and flags any disagreement, which means it conformance-checks Pyric's own sandbox against production while it checks your rules.

- **The stateful simulator session (`firestore_simulator_*`).** Seed, execute, batch, transaction, undo, redo, and an inspectable event log, as a session an agent drives. A scratchpad for rules and data with a real undo stack.

---

## Layer two, continued: operating real Firebase

The other half of the instruments is the control plane. Pyric does not only stand in for Firebase. It can operate a real project, over REST, with no `firebase` CLI, from Node or a browser or an agent.

This is the part I most under-weighted. The story is not only "deploy your rules." It is that an agent, given a service account, can stand up and configure real Firebase infrastructure end to end, over `fetch` and OAuth, with no `firebase-admin` and no CLI:

- Enable the Google APIs a step needs, by batch-enabling and polling the operation to completion.
- Enable auth providers on a live project (anonymous, email, phone, Google), with an honest boundary where Google's OAuth client cannot be minted from scratch and the tool says so.
- Manage authorized domains and OAuth redirect URIs, which is the fix for "I deployed a new hosting site and Google sign-in started failing."
- Create or ensure a Hosting site, provision a Firestore database, and run the whole Storage enablement sequence: enable the service, finalize the default location, create and link the bucket, deploy per-bucket rules, and set browser-ready CORS.
- Deploy rules, indexes, hosting, and functions, each step idempotent and returning a typed outcome.

The detail that makes this more than a deploy script: it encodes the gotchas the Console silently inflicts. It knows that the legacy project-wide storage rules release is not bound to modern buckets, so deploying there quietly leaves deny-all in place. It knows the CORS headers the Storage Web SDK needs. It knows a new hosting site breaks OAuth until its domain is authorized. That is operational Firebase knowledge, encoded as a tool that does the right thing and degrades honestly when your identity cannot.

---

## Layer three, the knowledge (why the agent gets good)

Here is the argument that ties it together, and it is the narrative spine.

A large model, on its own, is a mediocre Firebase engineer. It writes rules that look right and are quietly public. It writes queries that need indexes it does not create. It cannot debug a denial because it cannot see why. It does not know the rules compiler will reject its two-hundred-line function. It has read the docs, and the docs do not contain the hard parts.

Give that same model Pyric and it becomes good, measurably and visibly. It can:

- Design a data model and know the indexes it implies, because it can extract them.
- Write secure rules and prove them, because it can simulate and test them in-process.
- Debug a rule with precision, because the denial carries the rule and the data.
- Write a hard query and validate it, because it can run it against a conformant sandbox.
- Find security holes, because there is a skill and a tool for auditing rules and data posture.
- Attempt the genuinely hard thing, chess in rules, because the empirical limits and the patterns are encoded.

The clearest single piece of evidence is the rules linter. It is not a style checker. It carries the real compiler limits as thresholds: the two hundred fifty-six kilobyte source ceiling, the ninety-eight deep binary chain, the eleven let-bindings per function, the `get()` count, and a runtime expression budget that it correctly models as call-count-dependent and non-deterministic, with a documented "flaky zone" where a rule passes most of the time and intermittently returns a 403 under load. None of those numbers are in Firebase's documentation. They were found by testing the production engine, and the chess session is where several of them were pinned. The same linter ships a hallucination detector that catches the exact ways a model writes rules wrong: `.filter` and `.where`, `.includes`, `.toLowerCase`, optional chaining, arrow functions, each mapped to the rules-language equivalent. Firebase's tooling tells you a rule is invalid after you deploy it. Pyric's linter tells you why, before, in the language of the mistake the model just made.

I do not have a benchmark number. I do not need one to see the shape. The quality delta between "a model guessing at Firebase" and "a model wielding these tools" is the product. The mirror gets the agent into the room. The instruments and the knowledge make it competent once it is there.

The conformance system is the quiet backbone of this. Pyric holds recorded observations of how production Firebase actually behaves, replayed in CI on every change. When Pyric tells an agent how Firebase behaves, it is not repeating the docs. It is citing evidence. Pyric knows things about Firebase that are true and unwritten.

---

## Gaps this surfaced

The research turned up two things worth fixing as we write.

The stdlib manifest cites a patterns library, `PATTERNS.md`, by pattern number (config document, path blocking, piece-type-agnostic). That file does not exist in this build. The technique library the standard library leans on is cited but not shipped. Either it lives in the other repo and needs porting, or it needs to be written. It is exactly the kind of Firebase knowledge the new docs should carry, so this is an opportunity, not just a broken link.

And the whole knowledge layer, the standard library, the limits, the patterns, the observed behaviors, lives in source and internal specs today, not in anything a reader sees. The best material Pyric has is currently invisible. Surfacing it is most of the value of this rewrite.

## What this does to the docs

The reframe changes the plan in three concrete ways.

**The rules doorway is not one doorway. It is a wing.** "Secure it with rules" was a single outcome. It should carry the rules engine, the standard library, the patterns, the empirical limits, rule debugging with the verdict stream, and the auditing skills. This is arguably the strongest thing Pyric does and the docs should spend accordingly.

**We are teaching Firebase, and we can teach it better than the official docs.** That is a stance, not just a section. The pages should carry knowledge that is not on the Firebase site: the rules limits, the patterns, the stdlib, the observed behaviors. When we say how Firebase behaves, we can back it with a citation the docs cannot.

**The agent is not a section, it is the ambient reader, and the tools are the reason.** The "and from an agent" note on every page is not a courtesy. It is the payoff. Each outcome should show the human way and then the agent way, and the agent way is better because of a specific tool. The skills and the tool surface stop being an appendix and become the recurring proof.

The hierarchy in HIERARCHY.md v2 survives this, but it needs to grow the rules wing, add a home for the knowledge assets (the standard library, the patterns, the limits), and lean the agent thread harder on the instruments. I will fold both into a v3 after the two research threads land and after you react to this framing.

---

## Open questions this raises

1. Do we make "teaching Firebase better than the docs" an explicit, visible promise, or do we let the reader discover it? It is a strong claim. It is also true.
2. Does the rules standard library get its own top-level presence, or live inside the rules wing?
3. How much of the "makes your agent good" argument goes in the docs versus the marketing site and the README? The narrative is a landing-page thesis as much as a docs one.
4. Do we show the chess result? It is the single most convincing artifact and also the most niche. A "what is possible" gallery, or a case study, or left as a legend?
