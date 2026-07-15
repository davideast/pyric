# OUTCOMES

The conformance model is the parts bin. This is the reason anyone opens the docs.

We are not going to teach the parts. We are going to teach what people came to do. Firebase is old enough that we already know what they came to do. They want to build an app. They want their users to be safe. They want the data to behave. They want to ship without breaking the thing that is already live. And now they have an agent doing a lot of the typing, so they also want a place that agent can work without lighting production on fire.

Everything below works backwards from those wants. Each outcome starts with the end result, in the reader's words, not ours. Then the old friction. Then the shortest path Pyric gives them. Then the parts that make it real, so a writer can trace it. Then a note on how mature it is, because that decides how loudly we say it.

One rule threaded through all of it. We say Pyric, singular. Never "the packages." A person does not install a suite. They install a backend that runs in their browser, and they get on with their app.

---

## Who is on the other side of the screen

Picture the person who just bought a camera. They do not read the manual. They open YouTube, they find someone who clearly knows the camera and clearly likes them, and they watch that person take a photo. Then they go take the photo.

That is our reader. They know Firebase, or they know they are about to. They are building for the web, mostly, with a little Node for tests and scripts. They are smart and they are busy. They do not want a taxonomy. They want to see it work, and then do it themselves.

So we are the person in the video. We show the result first. We narrate the moves. We never hand them the manual and walk away.

---

## The shape of the journey

A Firebase project has a natural arc, and every outcome lives somewhere on it.

You start. You build. You lock it down. You watch it run. You hand some of it to an agent. You shape the data. You ship. And underneath all of it, you test.

That arc is the candidate spine for the hierarchy. It is verbs the whole way down. It never once says the word "package." Hold it loosely. It is here to be argued with in step 3.

---

## The outcomes

### 1. Start without asking permission

**The result they want.** A working Firebase backend in the time it takes to run one command. No account, no console, no project, no emulator, no Java.

**The old friction.** Firebase starts with a bill of setup. An account. A project. Enabled services. The Emulator Suite and its Java dependency. Then hand-wired switching between emulator and production in the SDK. None of that is the app. All of it is in the way.

**The Pyric path.** One command and the backend is the page itself. The app's own `firebase/*` imports resolve to a local sandbox. Nothing in the source changes. A developer has a full Firebase stack in the first ten seconds. Then they forget it is there.

**The parts behind it.** `pyric dev` serving the app against the in-process sandbox. `pyric init --template web` for a fresh start. The Vite plugin for a source-driven app that wants its own dev loop. The import-map swap and the SharedWorker sandbox.

**Maturity.** Core. This is the first thing anyone sees and it has to be flawless.

### 2. Build the app, for real

**The result they want.** Write ordinary Firestore and Auth code, and watch it work against a backend that behaves like the real one.

**The old friction.** To see your code run against anything Firebase-shaped, you needed the cloud or the emulator. Both are a context switch away from the tab you are actually working in.

**The Pyric path.** You write `signInWithPopup`, `collection`, `onSnapshot`, `runTransaction`, the calls you already know. They run in the page. A signed-in user, a live query that updates, a transaction that retries. All of it local, all of it shaped like production, because it is tested against production.

**The parts behind it.** The Firestore mirror (reads, writes, queries, aggregations, live snapshots, transactions, batches, field values). The Auth mirror (sign-in every way, sessions, tokens, profiles, providers). The conformance system that makes "behaves like the real one" a tested claim and not a hope.

**Maturity.** Auth and Firestore are v1 and conformance-held. This is where we plant the flag. Realtime Database and Storage exist and are documented, but they are experimental, and we will say so plainly rather than let a reader trust them by accident.

### 3. Know your rules actually protect the app

**The result they want.** Confidence that a signed-in user can save their own document and cannot touch anyone else's, proven before a single deploy.

**The old friction.** Security rules are where Firebase apps quietly break. You write them, you deploy them, you hope. Testing them meant standing up the emulator or the Rules Test API, which is a project away from where you write.

**The Pyric path.** Rules are a library here, not a deploy target. Lint them. Simulate a hypothetical request and read the verdict. Write a real test suite. Ask, in plain terms, whether this operation would be allowed for this user, and get an answer with the exact rule and data that decided it. And when your running app hits a denial, it does not throw a bare `permission-denied`. It hands you the verdict.

**The parts behind it.** The rules engine (parser, linter, validator, simulator, the Rules Test API client). The rules-verdict event on every operation. Denial inspection in the running app and in Studio. `pyric firestore rules lint`, `pyric firestore rules simulate`, and the agent tools that wrap them.

**Maturity.** Core and a headline. Rules is one of the three conformance-held surfaces, and it is arguably the single best reason to reach for Pyric.

### 4. See exactly what your app is doing

**The result they want.** Watch every read, write, and denial as it happens, and understand why something was blocked, without adding a single log line.

**The old friction.** Firebase is a black box in dev. You infer what happened from what broke. Denials are opaque. Listener churn is invisible.

**The Pyric path.** Every operation the backend performs is a typed event, including the rules verdict, the identity, and for a denial, the rule and data that produced it. The diagnostics are just consumers of that stream. Open Studio and watch the traffic live. Or read the stream yourself and build your own view.

**The parts behind it.** The single sandbox event stream (request, write, snapshot delivery, listener lifecycle, session boundary, mutation, commit). Studio's Traffic surface and denial inspection. The `@pyric/ui` traffic components for a custom console.

**Maturity.** Core. It is the quiet superpower that makes everything else legible.

### 5. Give your agent a safe place to work

**The result they want.** Let a coding agent build and exercise the backend, run its own reads and writes, and check its work, all without touching production and all inspectable afterward.

**The old friction.** An agent pointed at real Firebase touches real infrastructure. Every write, deploy, and rules change needs a human watching. That is slow, and it is scary.

**The Pyric path.** The whole backend becomes a tool surface the agent can drive. One bridge exposes the sandbox over MCP, and the agent works against the same local backend the app and Studio see. It can seed data, run a stateful Firestore session with undo and redo, simulate a rules verdict before writing, and inspect what exists. Nothing it does leaves the machine. You can watch all of it in the event stream.

**The parts behind it.** `pyric dev --bridge` and the MCP tool surface. The stateful `firestore_simulator_*` session, `sandbox_inspect`, `rtdb_validated_write`, `firestore_simulate_rules`. Studio's Prototype tab, an agent working against the shared sandbox in view. The Claude Code plugin that wires it up.

**Maturity.** Core to the story, and the newest ground. We show it working, and we are honest that the tool surface is wide and still consolidating.

### 6. Shape your data like it is source

**The result they want.** Seed a scenario, save it, reset it, branch it, and replay it, the same way they edit and revert a file.

**The old friction.** In the cloud, your dev data is a shared, mutable, half-remembered mess. Getting back to a known state means clicking around a console or writing a teardown script.

**The Pyric path.** The backend is local state, so you treat it like state. Seed data and rules at the start. Snapshot the moment it looks right and commit the fixture. Reset between tests in one call. Fork a branch to try something risky and throw it away. Replay a captured session against new rules to see what changes.

**The parts behind it.** Sandbox seeding, `snapshot`/`loadSnapshot`, `reset`, the branch operations (fork, apply, diff, promote, discard), and `replay`. `pyric snapshot` to promote lived state to a committable fixture, `pyric dev --seed` to serve it back.

**Maturity.** Core. This is the part that feels like a cheat code once it clicks.

### 7. Ship to production with confidence

**The result they want.** Deploy the rules and indexes they already proved, and find out which operations would change verdict before production finds out for them.

**The old friction.** The leap from "works in dev" to "live" is a leap of faith. Rules were tested somewhere else, if at all. Indexes were hand-maintained. Nothing told you what would break until it broke.

**The Pyric path.** The same code that ran against the sandbox ships to real Firebase, no rewrite. Rules leave the sandbox already exercised against the app's real behavior; ship them with `firebase-tools` / Console. Composite indexes come out of your actual query shapes instead of a hand-kept file. And `pyric verify` replays a captured session against a candidate ruleset and tells you which operations flip verdict, before prod does.

**The parts behind it.** `firestore_extract_indexes` / `pyric firestore indexes generate`. `pyric verify` with its sandbox and Rules Test API engines (`@pyric/cli/credentials/node` for SA/ADC). Production shipping via `firebase-tools` / Console. The production build that keeps the real `firebase` package.

**Maturity.** Core, and it is the proof that this is a development tool and not a toy. It literally deployed its own website.

### 8. Run the same backend in Node

**The result they want.** Use the exact same backend in tests and scripts, with no browser, and reach for the admin shape when the code calls for it.

**The old friction.** Backend tests meant mocks, or the emulator, or a throwaway project. Admin code and client code lived in different worlds with different setups.

**The Pyric path.** Pyric runs in the Node process too, so a test gets the whole backend with no browser involved. When you need the privileged, admin-shaped surface, activated development resolves canonical Firebase Admin imports to the sandbox mirror. With activation absent, production loads Firebase Admin directly. A Node script, the browser app, and an agent can share one pool of sandbox data over the bridge.

**The parts behind it.** `pyric` in Node. `pyric-admin` with its one-line sandbox seam and its ambient env mode. The remote sandbox that relays Node calls to the browser-hosted worker with the admin lens.

**Maturity.** Core for the client-in-Node path. The admin-shaped sandbox mirror is uneven by service, so we teach the activation seam and are precise about the edges.

---

## What this tells us about the hierarchy

A few things fall out of the outcomes, ahead of the step 3 conversation.

The left nav wants to read like that journey. Start, build, secure, observe, hand to an agent, shape state, ship, test. Those are the doorways. Not "firestore," not "sandbox," not a package name.

Auth, Firestore, and Rules carry the weight. They are v1 and proven, so the outcomes built on them come first and loudest. Realtime Database and Storage appear where they are genuinely useful, wearing an experimental label, never with equal billing.

The nouns get exactly one home. A single API reference section at the very bottom, one entry per package, for the reader who already knows what they want and just needs the signature. That is the only place we organize by package, and it is on purpose.

And a lot of the current pages survive as raw material, not as structure. There is deep, good writing already in the rules, sandbox, and deploy trees. We are not throwing the prose away. We are re-hanging it on doorways a person would actually walk through.

---

## Open questions for step 3

These are the forks I do not want to pick alone.

1. Is the journey (start, build, secure, observe, agent, state, ship, test) the spine, or do we want fewer, broader doorways?
2. Does "give your agent a safe place to work" stand as its own top-level doorway, or is the agent woven through every outcome as a second audience?
3. How do we place the experimental services? A labeled shelf inside each relevant outcome, or a single honest "what is experimental" page they all point to?
4. Where does the conformance story live? Its own doorway ("how we know it matches Firebase"), or a trust note folded into the build and ship outcomes?
5. How deep does the getting-started path go before it hands off to the outcome pages? One page, or a short guided sequence?
