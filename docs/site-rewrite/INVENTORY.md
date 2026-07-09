# INVENTORY

The factual capability surface of Pyric, grounded in the code at latest `main`. This is raw material for the docs rewrite: what the system can actually do, what is mature, what is experimental, and what the current docs already cover. Verified against the packages `pyric`, `pyric-admin`, `pyric-tools` (not `@pyric/ui`). Every claim traces to a file; a writer can open it and confirm.

This document names nouns on purpose. It is the parts bin. OUTCOMES.md turns it into verbs.

---

## 0. One system, three packages

Pyric is one system. The packages are how it ships, not how it is taught.

| Package | Runs where | Is the mirror of | Carries |
|---|---|---|---|
| `pyric` | the app process (browser page or Node) | `firebase` (Web SDK) | the SDK mirror, the sandbox runtime, the rules engine |
| `pyric-admin` | Node | `firebase-admin` | the admin-shape mirror, over a sandbox or over production |
| `pyric-tools` | Node CLI + Vite + editors | `firebase-tools` | the `pyric` CLI, the Vite plugin, the MCP surface, the deploy control plane, Studio |

The whole point of the mirror: application code keeps its `firebase/*` imports and calls unchanged. During development they resolve to a local sandbox. In production they resolve to real Firebase. The seam is one setup line (or zero, in ambient Node mode).

Versions: all three at `0.1.0-alpha.8`. ESM-only, Node 22+.

---

## 1. Maturity tiers (this shapes everything)

The single most important fact for the hierarchy. The services are not equal.

**Conformance-held, v1-supported: Auth, Firestore, Rules.** These are proven against recorded production behavior and are the surfaces a user should trust today.

**Experimental, explicitly not v1: Realtime Database, Storage.** They work, they are documented, but most of their behavior is not yet pinned to a production observation. Their COMPAT headers say so out loud (`packages/pyric/docs/database/COMPAT.md:6-13`, `packages/pyric/docs/storage/COMPAT.md:6-11`).

**Not present: Messaging.** The README says "soon"; there is no Messaging service in the code.

Conformance numbers today (rows / conforming):

| Service | Rows | Conforming | Tier |
|---|---|---|---|
| Firestore | 139 | 131 | v1 |
| Auth | 74 | 63 | v1 |
| Realtime Database | 170 | 144 | experimental |
| Storage | 111 | 92 | experimental |

Rules and Sandbox have no COMPAT matrix. They are the tooling and the harness, not a mirrored SDK.

---

## 2. The Web SDK mirror (`pyric`)

Runs inside the app process. In the browser, the process is the page: the whole backend executes in the tab. In Node, it is the Node process, so tests and scripts get the same backend with no browser.

Every service handle is branded (`TARGET_SYMBOL`) and routes to a sandbox backend or a real Firebase backend. Same call sites either way.

### Firestore (`pyric/firestore`, v1)
`firestore/index.ts` (2270 lines) mirrors the `firebase/firestore` modular SDK.
- Init: `getFirestore`, `actingAs(sandbox, identity)`, `getAdminFirestore` (rule-bypass).
- Reads: `doc`, `collection`, `collectionGroup`, `getDoc`, `getDocs`.
- Writes: `setDoc` (with merge), `updateDoc`, `deleteDoc`, `addDoc`.
- Queries: `query`, `where`, `or`, `and`, `orderBy`, `limit`, `limitToLast`, cursors `startAt`/`startAfter`/`endAt`/`endBefore`.
- Aggregations: `count`, `sum`, `average`, `getCountFromServer`, `getAggregateFromServer`.
- Realtime: `onSnapshot` (doc + query).
- Transactions/batches: `runTransaction`, `writeBatch`.
- Field values: `serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, `deleteField`; `FieldValue`, `Timestamp`.
- Converters/equality: `withConverter`, `refEqual`, `queryEqual`, `snapshotEqual`.
- Sandbox-only: `getFirestore(...).setRules()`, `.seed()`, `.snapshot()`; `sandbox` namespace; `SandboxInspect`.
- Deny-listed (`docs/firestore/reference/feature-matrix.md`): all IndexedDB persistence/cache APIs, `getDocFromCache`/`getDocFromServer`, `loadBundle`/`namedQuery`, `findNearest` vector search, `disableNetwork`/`enableNetwork`, `waitForPendingWrites`, `initializeFirestore`, `terminate`, `connectFirestoreEmulator`.

### Auth (`pyric/auth`, v1)
Mirrors `firebase/auth` modular SDK.
- Sign-in: `signInAnonymously`, `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `signInWithPopup`, `signInWithRedirect`, `getRedirectResult`, `signInWithCredential`, `signOut`.
- Session/token/profile: `setPersistence`, `onAuthStateChanged`, `onIdTokenChanged`, `getIdToken`, `getIdTokenResult`, `updateProfile`.
- Providers: `EmailAuthProvider`, `Google/Facebook/Github/OAuthProvider`.
- Sandbox-only driver: `sandbox.setUser`, `seedUsers`, `setAuthFlowResolver`, `listIdentities`, `createSignInCredential`, `mockSignInResult`, `exportUsers`, `restoreSession`, per-connection session minting.
- Deny-listed: `signInWithCustomToken`, `signInWithPhoneNumber`, `signInWithEmailLink`, MFA, `SAML/PhoneAuthProvider`, `sendPasswordResetEmail`, `linkWithCredential`, `reauthenticateWithCredential`, `user.delete()`.

### Realtime Database (`pyric/database`, experimental)
Two surfaces in one package.
- Modular SDK (`database/modular.ts`): `getDatabase`, `ref`, `child`, `get`, `set`, `update`, `remove`, `push`, `onValue`, `onChildAdded/Changed/Removed/Moved`, `off`, `runTransaction`, `serverTimestamp`, `increment`; query builder `orderByChild/Key/Value`, `startAt`, `equalTo`, `limitToFirst/Last`.
- Agent-tool + rules toolkit: `getRtdbTools`, factories for the 11 RTDB agent tools, IR generator, simulator, validated write, structure crawl.
- Rules constraint DSL (`database/constraints`): `expr`, `all`, `any`, `not`, `deny`, `allow`, `turnGuard`, `schemaRules`, `defineRtdbRules`.

### Storage (`pyric/storage`, experimental)
Mirrors `firebase/storage` plus a control plane.
- Object API: `ref`, `uploadBytes`, `uploadString`, `getBytes`, `getBlob`, `deleteObject`, `getMetadata`, `updateMetadata`, `listAll`.
- Rules (in-process): `parseStorageRules`, `evaluateStorageRules`.
- Admin/control plane (`storage/admin/`): `provisionStorage`, `enableStorageService`, `deployStorageRules`, bucket CORS, `createStorageAdminTools`.
- Out of scope for v1: `getDownloadURL`, paginated `list`, `uploadBytesResumable`, Storage emulator parity, image transforms, Functions triggers.

### The sandbox runtime (`pyric/sandbox`)
The engine under every service. `initializeSandbox(config?)` returns a `Sandbox`.
- Identity: `withAuth(auth)` binds an identity to a `SandboxContext`; `null` is anonymous.
- Observability: `onEvent(cb)` is one typed event stream. Members (`sandbox/types.ts`): `request` (per-op rules verdict allow/deny), `write` (committed, with sentinel info), `snapshot_delivery`/`snapshot_suppressed`, `listener_attach/detach/errored`, `session_boundary` (reset/dispose), `service_mutation` (before/after), `operation`, `commit`. Every event carries provenance.
- Replay: `history()` returns the full event array; `replay(events, rules?)` re-issues captured writes against a fresh sandbox and reports divergence.
- State: `reset()`, `snapshot()`, `loadSnapshot()`, `admin` (rule-bypass reads), `currentUser` + `onCurrentUserChanged`.
- Branches (`sandbox/branches/`): `fork`, `apply`, `diff`, `promote`, `discard` from a snapshot.
- Persistence backends: `createMemoryBackend`, `createIndexedDBBackend`, `attachPersistence`; serialization + rehydration.
- Cross-tab: `attachTabSync` (BroadcastChannel).
- Remote: `REMOTE_SANDBOX`, `isRemoteSandbox` — a Node handle onto a browser-hosted worker sandbox.

### The rules engine (`pyric/rules`)
Firestore and RTDB rules as a library. Browser-safe core; Node-only disk pieces split to `pyric/rules/node`, TS-compiler-heavy extractor to `pyric/rules/extract`.
- Parse/AST: `parseToAST`, `parseFunctions`, `assembleRules`, `validateFirestoreRules`.
- Lint: `lintFirestoreRules` → warnings + metrics.
- Modules stdlib (a 2+ modules extension): browser + Node resolvers, `STDLIB_MODULES`.
- Simulate (local, no network): `SimulateFirestoreRulesHandler`, `evaluate`, trace recorder, value wrappers (Timestamp, Path, Reference, Bytes, Duration, LatLng), sentinel-expression engine used by the sandbox for `$expr` resolution.
- Test (hosted): `TestFirestoreRulesHandler` against the Firebase Rules Test API (needs a `ProjectScope`).
- Deploy/inspect over REST: `WriteFirestoreRulesHandler`, `InspectFirestoreRulesHandler`.
- Index extraction: `extractIndexes` — static analysis of `query(collection, where, orderBy)` in source.
- RTDB rules: `pyric/rules/rtdb` + the constraint DSL.

---

## 3. The admin mirror (`pyric-admin`)

Mirrors `firebase-admin` in Node. The defining trick: admin code is byte-identical to `firebase-admin` except one line, and the same code can point at a sandbox or at real production.

The switch is the app handle. `initializeApp` has three arms (`src/app/index.ts:182`):
- `initializeApp({ credential })` → production (delegates to real `firebase-admin`).
- `initializeApp({ sandbox })` → sandbox. The one pyric-flavored line.
- `initializeApp()` (bare) → ambient. `PYRIC_SANDBOX` env decides; zero pyric identifiers in source. A production guard refuses sandbox routing when `NODE_ENV=production` unless forced.

Services (`pyric-admin/{firestore,auth,database,storage}`):
- **Firestore**: sandbox only (local or remote). A production app throws; use `firebase-admin/firestore` directly for prod.
- **Auth / Database / Storage**: three backends each. Local sandbox (in-memory), remote sandbox (relays to the browser SharedWorker), and production (returns genuine `firebase-admin` objects, full surface).

Remote is the interesting one. A remote-branded sandbox carries a worker-relay channel; each service relays ops over the bridge to the browser-hosted sandbox, pinned to `actAs:{mode:'admin'}` for the admin rules-bypass. That is how a Node script, the browser app, and an agent all see one shared pool of data and users.

Sandbox-backend gaps (production arms are complete): local auth has no tenancy/MFA/bulk-ops/updateUser; local database has no listeners/transactions/queries; storage has no streaming/resumable, and remote storage is single-bucket with an 8 MiB per-op cap. Everything unimplemented throws an explicit remediation error, never bad data.

---

## 4. The toolchain (`pyric-tools`)

The `pyric` CLI plus everything around it. Dispatcher `src/cli/index.ts:440`.

### CLI commands
- **`pyric dev`** — serve the app against the in-process sandbox. Unmodified `firebase/*` imports resolve through a served import map to a SharedWorker sandbox (one backend shared across tabs, durable in IndexedDB; falls back to per-tab). `firestore.rules` deployed at load and hot-reloaded over SSE. Runs your own dev command too (`-- <cmd>` or the package's `dev` script) with `PYRIC_SANDBOX` set. Flags: `--ui` (Studio at `/__pyric/ui/`), `--bridge` (MCP at `/__pyric/mcp`), `--persist`, `--fresh`, `--seed <file>`, `--no-capture`, `--no-watch`, `--port`, `--host`, `--allowed-host`, `--no-run`, `--json`.
- **`pyric init [dir]`** — scaffold a project. `--template web|node`, `--name`, `--force`.
- **`pyric vendor [dir]`** — retrofit pyric into an existing project (standalone binary).
- **`pyric snapshot`** — promote lived sandbox state to a committable fixture that `dev --seed` re-serves. `--out`, `--force`, `--include-passwords`.
- **`pyric verify [fixture]`** — replay a captured session against a candidate ruleset for Firestore/RTDB. Engines `--engine sandbox|rules-test-api|both`. `--service`, `--rules service=path`. Exit 1 on divergence. Also `pyric verify cases`.
- **`pyric bridge`** — standalone HTTP+WS MCP bridge. sandbox mode relays to the browser; prod mode is a v1.1 follow-up (currently bails).
- **`pyric mcp`** — stdio MCP server for editors; headless sandbox or attaches to a running `dev --bridge`.
- **`pyric deploy <target>`** — push to a real project over REST. Targets: `rules`, `indexes`, `database`, `hosting`, `functions`, `storage`. `--project`, `--only`, `--channel <id|auto>`, `--expires`, `--schema`, `--json`.
- **`pyric hosting:channel:deploy <id>`** — preview-channel mirror of `deploy hosting --channel`.
- **Rules CLI**: `rules:lint`, `rules:validate`, `rules:simulate --stdin`; `database:rules:lint|validate|simulate`.
- **Real-project helpers**: `auth:configure-provider`, `auth:manage-domains`, `firestore:discover`.
- **Auth**: `login [--ci]`, `logout`, `whoami` (loopback OAuth + PKCE, credential at `~/.pyric/credentials.json`).

### The Vite plugin `pyricSandbox()`
The same `firebase/*` → sandbox swap for a source-driven Vite app, at module-resolution time, inside the normal `vite dev` loop (HMR, source maps). Options: `rules`, `root`, `persist`, `fresh`, `seed`, `capture`, `bridge`, `swapInBuild`.
- `vite dev` always swaps.
- `vite build` (production) ships real firebase with the same config — no graduation step.
- `vite build --mode development` (or `swapInBuild:true`) makes a sandbox build (marked in `index.html`); `pyric dev` serves it, `pyric deploy hosting` refuses it.

### The MCP tool surface
The sandbox and its services exposed as agent-callable tools over MCP. Doc says 51 unique names; the composed registry (`composeMcpRegistry`, profiles `full` / `browser-parity` / `control-plane-only`) actually registers more (it adds the verify tools the doc omits). Categories: Firestore data + inspect (7), Firestore rules (6), Firestore simulator session (9), index extraction (1), RTDB rules (4), RTDB data (7), storage control plane (2), deploy (12), discovery (2), auth config (3), verify (2). The ones with no equivalent elsewhere: `firestore_simulate_rules`, the stateful `firestore_simulator_*` session, `sandbox_inspect`, `rtdb_validated_write`, `firestore_extract_indexes`, `firestore_discover_paths`, and the deploy factories.

### The deploy control plane
`pyric-tools/deploy` — Hosting, Cloud Functions Gen 2, Firestore rules/indexes/database, RTDB rules, Storage, as pure `fetch` over OAuth tokens, no `firebase` CLI, runs in Node and browser. Credential model `ProjectScope = { projectId, resolveToken }`, from a service account, a firebase-admin app, or a browser `getIdToken`. CLI precedence: `FIREBASE_SA_BASE64` → `GOOGLE_APPLICATION_CREDENTIALS` → `PYRIC_REFRESH_TOKEN` → login → ADC.

### Studio (`@pyric/studio`, behind `pyric dev --ui`)
Local console at `/__pyric/ui/`. Eight tabs (`packages/studio/src/shell/routes.ts`): Home, Firestore, Auth, RTDB, Storage, Traffic, Prototype, Settings. No in-app Docs tab (the composed static site mounts `/docs`; a spec-named Rules tab is intentionally not mounted yet). Prototype is the embedded playground (an agent working against the shared sandbox).

---

## 5. What proves it matches Firebase

The claim "it behaves like Firebase" is tested, not asserted. Probes run against a real Firebase project and record its behavior as observations (`scripts/oracle/`). CI replays every observation against the sandbox on every change. The public contract is the COMPAT matrix per service (section 1). Firestore and Auth distinguish three targets: sandbox (frozen context), sandbox-live (per-op identity, what the playground uses), and prod. A documented divergence is a row; an undocumented one is a bug.

---

## 6. The existing docs (what we are replacing)

184 generated pages. Everything except one hand-written QA page is generated by `packages/site-docs/scripts/port-content.ts` from the per-package `docs/` trees. The rewrite target is those source trees plus the nav plan in `port-content.ts`, not the generated collection.

Current shape: **package-and-noun first**. Slug = `<pkg>-<service>-<diataxis>-<topic>` (for example `pyric-firestore-how-to-build-queries`). Nav is one disclosure per package subtree, Diataxis (Tutorials / How-to / Reference / Explanation) as the inner axis.

Coverage by group:

| Group | Pages | Notes |
|---|---|---|
| `pyric/firestore` | 19 | full Diataxis + COMPAT |
| `pyric/rules` | 28 | deep; no COMPAT (tooling) |
| `pyric/sandbox` | 26 | deep; no COMPAT (harness) |
| `pyric/storage` | 15 | experimental |
| `pyric/auth` | 5 | reference + compat only, no how-to/explanation |
| `pyric/database` | 5 | experimental |
| `pyric-admin/firestore` | 14 | only admin service documented |
| `pyric-tools` (root) | 14 | dev, init, verify, vite, adoption |
| `pyric-tools/deploy` | 27 | deep |
| `@pyric/ui` | 30 | not Diataxis; out of scope for this rewrite |

Examples (`examples/`): `vite-sandbox-app` (the flagship, the shape `pyric init --template web` scaffolds) and `admin-playground` (a `@pyric/ui` showcase).

### Staleness and imbalance to fix
- **Coverage is inverted from importance.** Auth is v1 and load-bearing but has 5 pages and no how-to or explanation. RTDB and Storage are experimental yet carry equal nav weight to v1 surfaces.
- **The hierarchy is nouns.** Package → service → Diataxis. A reader who wants to "let a signed-in user save a document safely" has nowhere to land; they must already know it spans auth + firestore + rules.
- **Emulator-connector rows persist** (`connectFirestoreEmulator`, `connectStorageEmulator`) despite the firm no-emulator position. Retire candidates.
- **The tool count is grep-derived** and the README itself flags consolidation is ongoing. Do not hard-code "51".
- **`@pyric/ui` is not Diataxis** and is out of scope here; it becomes the only package-named section (API reference), per the nav philosophy.

---

## 7. The seams that make good outcomes possible

A short list of the load-bearing behaviors, because these are what the outcomes will be built from.

1. **The same code runs against a sandbox in dev and real Firebase in prod.** No rewrite, no graduation. One import map or one Vite plugin.
2. **The backend is local state.** Seed it, snapshot it, reset it, fork it, replay it, the way you edit a file.
3. **Every operation is an observable event** with its rules verdict, including denials with the rule and data that produced them.
4. **Rules are a library**, not a deploy target. Lint, simulate, and test them in-process, in CI, and from an agent.
5. **The whole thing is an agent tool surface.** One MCP bridge exposes the sandbox so an agent drives the same backend the app and Studio see.
6. **Work carries to production.** Rules exercised against real behavior, indexes extracted from query shapes, and a replay that tells you which operations change verdict before prod finds out.
7. **One identity model across web and Node.** `withAuth` in the sandbox, the admin lens for privileged reads, the same shared pool over the remote bridge.
