# Live mode research

Status: research for a decision, 2026-10-27. Main at `66e7a7f53`. The seven research tracks read main at `dddc74a36` (the commit before #1394 merged; no live mode code changed between them). Nothing here is a plan of work.

## 1. Summary

Recommended design: live mode is SDK pass-through. Pyric's `firebase/*` modules re-export the real Firebase SDK in full, so the app talks to Google itself, as its own signed-in user, with its own App Check token. Pyric watches at the module boundary and records request shapes, never values. Pyric's tools refuse every write in code, below the agent. With the deployed rules, read once per session, pyric predicts each observed answer locally, labels the prediction as its own, and compares it with production's verdict. The comparison stays on the machine until the user exports a repro.

Pyric's own code holds one production credential, a rules-only one, and live mode refuses to start with a credential that can read or write data. The live session itself also contains the app user's ID and refresh tokens and an App Check debug token. Pyric does not copy them, but it cannot protect them from an agent with a shell on the same machine (section 9).

The main reason: only this path keeps production's own rules in charge of the app's requests. The app's ID token reaches Google, so a denial is real evidence, and pyric does not become another tool that bypasses rules with admin authority, which is the pattern behind the agent incidents the prior-art track found (track 6, section 7). Production's rules are the safety boundary only to the extent they are strict: the largest Firebase exposures in track 6 came from permissive rules, not from admin tools. The path also forwards the whole surface by re-export, which is what the parked attempt lacked.

Three costs come with it and shape the stages. Proving each stage through real entry points means answering Firestore's streaming RPCs in CI, which is close to the decoding work that counts against the wire proxy (section 4). The app's own `firebase-admin` falls outside the safety argument and has to be refused on a live session. And "read-only" for the app has more holes than the SDK's write functions, most of them in Auth.

All denial facts come from Node gRPC probes. Browser behavior is inferred; no browser probe was run. The first stage that puts production-derived content on a dev server route waits for the attack-surface hunt (#1325).

## 2. What live mode is, and the bar it must pass

Live mode connects pyric's tools (Studio, denials, rules explain, `pyric verify`, the listener chip, the MCP tools) to a real Firebase project while the app's data flows through pyric (`PRIORITIES.md`, "Live mode"). A real app using pyric asked for it.

Two bars apply.

**Ruling D3** (`docs/hosted-release-plan.md:45`): live mode stays off main "until it forwards the full Firestore surface or documents each refusal with a scenario". Ledger D1 (`docs/hosted-review-ledger.md:272-274`) spells out the surface: "Reads, queries, document listeners, query listeners, writes, batches, transactions, converters, metadata options, and the network/cache controls exposed by the normal Firestore entry need explicit forwarding or a documented refusal backed by a scenario." Acceptance: "either the full surface with scenarios, or per-operation refusals each backed by a scenario."

**The #1394 test** (`PRIORITIES.md`, "Live mode"): "Does this move live mode toward a safe, evidence-backed design, or deliver a stage of that design?"

- Counts: research and probes that settle the design; safety guarantees against accidental production writes; comparisons that keep user data on the user's machine and record request shapes, not values; stages that forward the full surface or document each refusal with a scenario.
- Doesn't count: forwarding part of a surface without documenting the rest; anything that sends user data off the machine without the user's explicit action; production calls added only to make a comparison possible.

AGENTS.md item 7 sets what a scenario is: an app scenario under `test/apps/` that installs the packed packages and drives a real entry point (the dev server, a `node --import @pyric/cli/register` process, Chromium, the `pyric` command). A test that "fakes the socket" is unit evidence. The harness also states that "no scenario reaches a Google or Firebase production endpoint" (`test/apps/README.md:8`). Those two rules together are what makes stage evidence expensive (section 4).

This document lives under `docs/research/`, not under the `hosted-sandbox-live-mode-*` names that `packages/cli/test/cli/ledger/d3-live-removal.test.ts` keeps off `docs/`.

## 3. What the parked attempt taught

Source: track 1, reading `origin/live/parked` at `2751e1d7b` (live code added in `4b2ae8814`, removed by `140394368`).

- It was a browser-only tracer bullet: about 90 lines that swapped `firebase/app` and `firebase/auth` for the real SDK, re-exported four Firestore names, wrapped `getDoc`, and threw at module load for every other service. `firebase/firestore` 12.13.0 has about 104 public runtime names (track 1 counted 104 non-underscore exports; track 2 counted 104 functions and 26 classes in the public `.d.ts`; a recount for this report found 106 runtime names, 30 of them capitalized, so the count depends on method and build). The mechanical answer is main's served export-completeness test, `packages/cli/test/serve/entries/ledger/i20-served-public-exports.test.ts`.
- It proved that an app's normal imports can reach the app's own real SDK with the right App and Auth owner, on both the served path and Vite, but only against the Firebase emulators, which the project does not accept as evidence (`docs/hosted-review-ledger.md:328`: "Any gate evidence that cites an emulator oracle is not evidence").
- It never recorded a denial: `getDoc`'s rejection propagated before the recorder ran, so every recorded event said allow (track 1, section 2). Its live init skipped the runtime, so Studio and the chip had no feed.
- Gates 7 through 9 (non-interference, honest evidence, surface and write policy, integrated entry, packaging, end-to-end observation, hosted credentials) had no implementation.
- Main has since built most of what a second attempt needs: one swap table for every plane (`packages/cli/src/serve/firebase-module-swap.ts`), the shadow-app pattern and App Check pass-through from production AI mode (`register/app-bridge-shadow.ts`, `register/app-bridge-app-check.ts`, commits `5807259eb`, `86ce56983`), import-safe per-call refusals (`serve/entries/unsupported/call.ts`, from `df408728b`), the `external-execution` rules disposition (`packages/pyric/src/sandbox/types/operation.ts:46`, from `9ec53e1fe`), bounded capture, the Node net guard, and app scenarios that answer Google from a Playwright route (`test/apps/ai-production-app-check/`).
- Porting beats rebasing: the branch is 927 commits behind main and its wiring targets functions main reshaped. The `getDoc` wrapper's shape (call the real SDK, return the original snapshot, record a copy, never call `data()`) and the parked gates and premortem are worth keeping as requirements.

## 4. The data paths

- A. Wire proxy: the SDKs point at a local pyric proxy that forwards to Google.
- B. SDK pass-through: pyric's modules re-export or wrap the real SDK, which talks to Google directly; pyric observes at the module boundary.
- C. Admin-side access: pyric talks to production with a service account or the developer's OAuth credentials.

Source: track 2, from the SDK builds installed in the repo (`firebase` 12.13.0, `@firebase/firestore` 4.14.1, `@firebase/auth` 1.13.1, `@firebase/database` 1.1.3, `@firebase/storage` 0.14.3) and Firebase docs.

| Concern | A. Wire proxy | B. SDK pass-through | C. Admin access |
| --- | --- | --- | --- |
| Auth tokens | App user's ID token reaches production. The proxy also sees every refresh token on `/v1/token` (`@firebase/auth` `esm/index-907e9a1a.js:873-880`). Auth has no public host setting; only `connectAuthEmulator`, which disables app verification and moves popup handlers (`:3795`, `:10322-10346`) | App user's ID token. Refresh, MFA, popups and phone sign-in behave as in production on an authorized origin: `localhost` is authorized by default and `127.0.0.1` is not, and redirect sign-in from an origin other than `authDomain` meets third-party storage partitioning in current browsers (review finding; not probed). The served origin is a setup requirement | Developer or service account identity, not the app user |
| App Check | Tokens pass through. A `localhost` page needs a debug token in every design (firebase.google.com/docs/app-check/web/debug-provider) | Real SDK attaches tokens, as main does for AI. Firestore, RTDB and Storage need App Check on the same app object, so the shadow-app attachment extends to them (inferred from `register/app-bridge-app-check.ts:1-11`) | Not involved (inferred) |
| Rules enforcement | Production enforces | Production enforces | Bypassed for Firestore and Storage: OAuth requests are checked by IAM and "ignore your security rules" (firebase.google.com/docs/firestore/use-rest-api). RTDB can restore rules with `databaseAuthVariableOverride` |
| Listeners | Must decode Firestore WebChannel framing in the browser, which has no public spec (inferred), and gRPC streams in Node. RTDB frames are plain JSON, but the handshake rewrites the client's host and stores it as `host:<db>` in persistent storage, so a proxy must rewrite it or the client reconnects straight to Google (`@firebase/database` `index.esm.js:950-972`) | Real SDK runs them; pyric sees callbacks and snapshot metadata | Admin streams through pyric's engine (inferred) |
| Offline and persistence | SDK's own; the cached RTDB host can bypass the proxy on the next start | SDK's own, unchanged. A persistent cache holds production values on disk | Replaced by pyric's engine (inferred) |
| Latency | One local hop plus decoding (inferred, small) | About none beyond a wrapper call (inferred) | Engine hop plus an Admin call (inferred) |
| Browser, in-page | Host seams for Firestore and RTDB; Storage and Auth only through emulator connectors that change behavior. Storage download URLs would carry the proxy host into saved data (inferred from `@firebase/storage` `index.esm.js:1458-1485`) | The swap table, as production AI mode | Pyric's surface over a Node backend |
| SharedWorker bridge | Observations posted in | Observations posted in; the real SDK runs in the page, not the worker | Engine plus Admin behind it |
| Node host | Needs an HTTP/2 gRPC proxy; Admin's emulator variable swaps in an owner token, so it cannot proxy to production (`@google-cloud/firestore` `build/src/index.js:585-589`) | Under `PYRIC_SANDBOX=remote` the app process talks to Google and only observations travel to the host (inferred) | Admin in the host process |
| Register | Same as Node host | The client SDK mapping returns the real SDK, as for production `firebase/ai` (`register/mapping.ts:73-78`); the net guard allows Google hosts through `PYRIC_GUARD_ALLOW`. The app's own `firebase-admin` is outside B's safety argument (below) | Admin in process |
| Surface coverage | All bytes forwarded; decoding per RPC kind; Auth flows broken by the emulator connector | Full surface forwarded by re-export; observation is per function, so each unwrapped name is "forwarded, not observed" | Only what pyric's mirror implements, each translated to Admin; everything else a refusal |
| CI evidence cost (scenarios through real entry points with no production call) | The proxy is itself the replay point, but the product decoder must be complete for every RPC the app uses | High. The only precedent answers one REST POST from a Playwright route (`test/apps/ai-production-app-check/scenario.ts:28-43`). Firestore's Listen and Write streams over WebChannel in the browser, and gRPC over HTTP/2 under register and the Node host, need a recorded replay server; Playwright routes do not reach a Node process at all. `firebase/firestore/lite` is REST and can be answered by a route | Low for the app path (pyric's own engine), but every Admin call needs its own replay |

### The app's own `firebase-admin` under register

A Node server app run under `node --import @pyric/cli/register` usually imports `firebase-admin`, which register maps to `pyric-admin` today (`register/mapping.ts:26-30`). In live mode there are three choices:

| Choice | Effect | Verdict |
| --- | --- | --- |
| Keep Admin on the sandbox | The server reads sandbox data while the browser reads production. Every server-backed page shows a mix | Rejected: the tools would show a fiction beside production (inferred) |
| Pass Admin through | The app's service account bypasses rules and writes production without limit | Rejected for pyric to offer: it is the C path, with the app's credential instead of pyric's |
| Refuse per call on a live session | Every `firebase-admin` import is import-safe; each call throws a pyric refusal with zero upstream calls | Recommended. A server that needs Admin runs outside register for a live session |

### Does the evidence cost undercut rejecting A?

Partly, and the report previously did not count it. B's scenarios need a replay of Firestore's streaming RPCs on the browser and Node planes, which is the same kind of decoding the proxy needs. The difference is where the cost lands. A's decoder sits in the product, must handle every RPC and SDK version an app sends, and must also solve Auth's missing host seam, Storage URLs, the RTDB host cache and holding refresh tokens, none of which a test replay has to solve. B's replay server lives only in tests, can cover only the RPCs a scenario drives, and fails closed when it meets one it does not know. So the rejection of A stands on its runtime problems, not on decoding cost. But the CI cost of B is real, and it raises a question the evidence cannot settle: whether a replayed stream counts as a real entry point, or as a "faked socket" that item 7 calls unit evidence (question 3).

### Verdict

B. It keeps identity, App Check, refresh, offline cache and popups as in production, the denial a user sees is production's, and it forwards the whole surface by re-export. Main already has the swap table, register mapping, shadow app and guard allowlist it needs (track 2, section 9). A fails on Auth, Storage URLs, RTDB redirects, undocumented browser framing, Node HTTP/2, and holding users' refresh tokens. C as the data path makes pyric's engine the only check on production and puts a credential broader than the task on the developer's machine.

What B costs, stated plainly: observation per exported function, coupling to the app's installed `firebase` version, no write commit times or transform results except through a later snapshot (track 4, "Write results"), the CI replay cost above, and the app's own Admin refused.

### Also considered

None of these were in the seven tracks. Each needs checking before it is relied on.

| Option | What it would give | Verdict |
| --- | --- | --- |
| B plus a network guard in the browser: a service worker, or a Content-Security-Policy `connect-src` with path-level sources, that blocks write endpoints (the Firestore `Write` channel, `commit`, Storage uploads, callables) | A read-only floor under the app that closes the raw `fetch` and queued-write holes that per-name refusals leave | Unverified. Promising as a backstop for an app-read-only stage. Unknown: whether path-level CSP sources distinguish the Listen and Write channels as the SDK builds their URLs, and whether a service worker sees WebChannel's XHR. Does not help on the Node planes, where the net guard is host-level only |
| Firestore's public `setLogLevel('debug')` | Per-RPC observation without decoding the framing; track 2 found the SDK logs each RPC (`common-7a7519be.esm.js:14342`), and track 4's P1 output shows stream errors in the debug log | Unverified. Couples to a log format that is not a contract, and the log carries values and resume tokens, so it could only be parsed in memory and reduced to shapes. Worth a probe as a cheaper observation source |
| Mirror production into the local sandbox and keep every tool local | All tools, including edits and impersonation, work on a copy | Rejected as live mode: a one-time Admin export bypasses rules and puts production data at rest in `.pyric/`. Seeding a sandbox from documents the session already observed is a sound, separate sandbox feature |
| Firebase's own sources: the console Rules Playground, and a Cloud Monitoring metric for rules evaluations | The Playground answers one hand-built request. A monitoring metric with allow, deny and error counts per project, if it exists as believed, would give an error-versus-deny split the client cannot see | Unverified: the metric's existence and labels were not checked. Even if present, it is per project, not per request, and needs a monitoring credential. At most a cross-check |

## 5. What production lets a client observe

Source: track 4, Node probes against the oracle project with `firebase` 12.13.0 and `firebase-admin` 13.10.0 (probes P1, P2, P4, P4b, P5, P7). No browser probe was run, so every browser transport statement is inferred.

| Fact about a request | Client sees (beside the SDK) | Needs Admin | Not observable | Evidence |
| --- | --- | --- | --- | --- |
| Allowed or denied | Yes: Firestore `permission-denied`, RTDB `PERMISSION_DENIED`, Storage `storage/unauthorized` | | | P1, P5, P7 |
| Which rule, line or expression denied | No | No (Admin cannot see it per request either) | Yes. Firestore sends `cause.details: []` (Node gRPC); RTDB sends `d: "Permission denied"` | P1, P5 |
| Whether a rule read other data (`get()`, `root.child`) | No | Admin can read the rules and the data, so pyric can predict it | The actual evaluation trace | P5 |
| RTDB `.validate` failure versus `.write` denial | No: identical frames | | Yes | P5 |
| Which member of a batch or multi-path update failed | No: one error for the group; the allowed half is absent afterward | | Yes | P1, P5 |
| Deployed rules source and the release serving traffic | No (client API key 403; ID token 401) | Yes: Firebase Rules API releases and rulesets, one release per Firestore database and per Storage bucket; RTDB `/.settings/rules.json` with an OAuth token | Exact pinning if rules change mid-request (inferred) | P4 |
| Error message text | Yes, but it varies by call path and transport, not by rule | | | P1 |
| Write commit time, server timestamp values | Only through a later snapshot or read (`setDoc` resolves `undefined`) | Admin `WriteResult.writeTime` | | P1, P2 |
| Listener metadata: `fromCache`, `hasPendingWrites`, change types and indexes | Yes | | | P2 |
| A listener ended by a denial | Yes: one error callback, no prior next event, after 80 to 120 ms | | | P1 |
| RTDB listener revoked when rule-dependent data changes | Yes: cancel callback within about 50 ms of the change | | | P5 |
| Timing | Wall clock around each call; a denial costs about as much as an allowed read | | Server-side breakdown | P7 |
| Signed-in identity and claims | Yes, from the Auth SDK (`getIdTokenResult`, inferred) | | | |
| App Check rejection versus rules denial | Unknown | | Not probed; enforcement must not be changed to test it | |

Two consequences carry through the rest of this document. Production gives a verdict and a code, never a reason, so any "why" pyric shows is its own prediction. And an exact prediction needs the deployed rules plus every document the rules read, which a client sees only when its own rules let it read them.

## 6. What each tool can do live

Source: track 3, reading main's tools. Almost every tool today reads the sandbox's store and evaluator through `RequestEvent` (`packages/pyric/src/sandbox/types/events.ts:129`). Live, the store and evaluator are production's. Method counts from the method records under `cli/src/bridge/surface/methods/`: 44 `read`, 56 `write`, 6 `destructive`, and 3 `production` (`storage.status`, `storage.provision`, `assurance.testRulesHosted`, the only methods that reach Google today). A literal grep of `cli/src/bridge` finds one more of each, from the heading list in `bridge/surface/tool-description.ts:44-48`.

| Tool | Verdict | Why |
| --- | --- | --- |
| Rules lint, stdlib, can-i-use, index extraction, rules and index file commands | Works unchanged | Pure functions of rules text or queries. Lint is more useful run on the deployed ruleset |
| Studio request log, traffic tab, session view | Adapt | Observations from wrapped calls go into the same feed AI observations use (`serve/worker/ai-observation.ts`). Needs a disposition that carries production's outcome: today `external-execution` renders as no verdict at all (`studio/src/features/traffic/verdict.ts:56-66`) |
| Studio data browser | Adapt, partial, and a value display | Shows only documents the session received, labeled partial. These are production values in a page; see section 9. A full listing needs Admin, which bypasses rules |
| Studio edits, create, delete, import, seed, rules Apply | Does not work | Each would be an admin write or a deploy to production. Refuse per action |
| Studio rules inspector, denial detail | Adapt through shadow evaluation | Shows pyric's predicted trace, labeled as a prediction, over the deployed rules |
| Re-run as another user, identity switcher, impersonation | Does not work | Live identity is the real signed-in user; impersonation must never become real authority (parked premortem, track 1 section 3) |
| Re-run against edited rules | Adapt | A local shadow evaluation with a draft ruleset; nothing goes upstream |
| Listener chip, listeners page | Adapt (unchanged in principle once wrapped) | Wrappers report to the same SDK activity journal (`pyric/src/sandbox/internal/sdk-activity.ts:7-60`). Suppressed deliveries and re-evaluation causes have no live source |
| Denial overlay, owner frames | Works unchanged | Page-side facts |
| Denial terminal block, `pyric serve denials` | Adapt | Production's code is the fact; any rule line is a labeled prediction |
| `rules.explainDenial`, `rules.simulate` | Adapt | The engine already runs standalone (`pyric/src/rules/simulator/handler.ts:491-500`); the bridge caller hardwires the sandbox as the source of `resource` and `get()` (`cli/src/bridge/surface/rules-simulation.ts:87,105`) |
| `pyric verify` | Adapt, large | Becomes the shadow-comparison tool. Its strict refusal of cases with unmocked `get()` reads (`cli/src/verify/cases.ts:96-107`) is the right model for "undetermined" |
| MCP data reads (Firestore, RTDB, Storage) | Adapt, shapes by default | The MCP process does not hold the app's token (inferred), so reads come from what the session observed. Values only by human opt-in (section 9) |
| MCP data writes, Auth admin, `createCustomToken`, sandbox state control, `functions.fire`, `messaging.*`, `rules.set` | Does not work | Each writes production, mints a real credential, reaches real devices, or has no production meaning. Refuse per method |
| MCP capture tools, local assurance tools | Unchanged | Local files and local engine runs; the contents become user data and stay local |
| The 3 `production` methods, `pyric verify --engine staging` | Refuse in a live session (recommendation) | They send cases to Google, provision production, or write production infrastructure; on a live session the cases derive from user data |
| Deployed-rules readers (`firestore_inspect_rules`, `rtdb_inspect_rules`) | Adapt | Unmounted today. The Firestore reader picks the newest of the latest ten rulesets, not a release (`pyric/src/rules/inspect/handler.ts:14-46`), the wrong input for shadow evaluation and a likely defect in any use |

### Shadow rules evaluation

Shadow evaluation runs pyric's evaluator on each observed request with the deployed rules and compares its verdict with production's. Inputs (track 3, section 3):

- Has: the request's uid and claims, incoming write data (from wrapper arguments), batch siblings, query shape, the client's clock, and documents the app already received.
- Lacks without Admin: prior resource data for a denied read or for a write the client never read, and `get()`/`exists()` targets the user cannot read. These are often exactly the cases that most need explaining.
- Engine gaps: named databases are hardcoded to `(default)` (`pyric/src/rules/simulator/document-lookups.ts:18-21`), so a prediction for a named database would bind the wrong `database`; nothing in the Firestore simulator models App Check; and the evaluator has no "unknown input" outcome, so a missing lookup reads as a missing document and yields deny.

Labeling rules (track 3, section 4), to be fixed before any live UI ships:

1. Production's outcome is the headline, in production's words: "Production denied this request (permission-denied)."
2. The prediction is a separate block with a fixed label that names pyric, such as "Pyric's prediction, from the deployed rules". Never "Reason" or "Why it was denied". The PRIORITIES phrase "production's reason" means pyric's model of production and must not appear next to a production verdict.
3. Agreement is stated either way: "Pyric's prediction agrees" or "Pyric's prediction disagrees: pyric would allow this. Production may have used rules or data pyric could not see."
4. Inputs are named with provenance: which release and ruleset (name and `updateTime`), whether `resource` came from what the app saw or was unknown, which `get()` targets were missing, and whether an App Check token was attached. An unknown input makes the prediction "undetermined", never deny.
5. In data shapes the prediction lives in its own field (for example `shadow: { verdict, evaluatedRule, reasons, inputs }`), never in the event's `reasons` or `evaluatedRule`, so existing renderers cannot present it as the evaluator of record. MCP results carry the same split.
6. A prediction for a request production allowed is a prediction too, not an explanation of the allow.

## 7. Live mode as a conformance source

Source: track 7. Production is the control and its answer is the one the app gets; pyric is the candidate, run in process, and only the comparison is kept (GitHub Scientist's model, track 6 section 5).

### What can be compared

| Signal | Exact when | Partial when | Impossible |
| --- | --- | --- | --- |
| Firestore rules verdict, single operation | Rules known with a release stamp, claims read in process, incoming data from the call, `resource` from a server-confirmed snapshot, every `get()` target seen, an App Check token attached | A `get()` target or `resource` unseen or stale; `request.time` near a boundary; the release changed since it was read; no App Check token attached (App Check rejections may look like `permission-denied`, unknown) | Answers from cache (no production verdict) |
| Firestore batch, transaction | Group verdict as the AND of exact member predictions | Any member partial | Which member failed |
| Firestore query (`list`) verdict | Rules, auth and query shape known; the list proof decides from the query | Rule calls `get()` on unseen documents | |
| Named database | | | Until the simulator binds `database`, every comparison on a non-default database |
| RTDB rules verdict | Rule reads only `auth`, `newData`, the path's `data`, and nodes pyric has seen | Rule reads `root.child(...)` or `data.parent()` nodes pyric has not seen | `.validate` versus `.write`; which multi-path member failed |
| Error code | `permission-denied`, `not-found`, `storage/unauthorized` | `failed-precondition` for a missing index (pyric does not see deployed indexes) | |
| Error message | Only after mapping to (code, call path, transport) | Browser text not yet probed | Text as such |
| Listener events | Self-consistency: pyric recomputes the change set from consecutive production snapshots plus the app's own writes | `fromCache`, unless cache state is controlled | |
| Resume tokens, read times | | | Not in the public API beside the SDK; the debug log may expose them (unverified, section 4) |
| Query results | Self-consistency: every returned document matches the filter and the order agrees with pyric's comparator | Cursor and `limitToLast` edges | Predicting the result set |
| Server-generated values | Presence, type and ordering | | The values |
| RTDB listener cancellation | Pyric saw the dependency change | Another client changed it | |
| `reasons`, `matchedRule`, `evalMs` | | | Production never says why |

A matching verdict confirms the verdict, not pyric's explanation of it.

### Noise

| Source | Handling |
| --- | --- |
| Other clients writing | Exact only if the input came from a live listener with no newer server event before the ack; otherwise partial |
| Other developers on the same project | Their traffic changes inputs the same way; treated as other clients |
| `request.time` | Evaluate at send time and at ack time; if the verdicts differ, partial |
| Cache | Compare only server-confirmed outcomes |
| Multi-tab persistence | With a multi-tab persistent cache one tab owns the network and the others receive snapshots through IndexedDB, so secondary tabs have no production verdict of their own and may report the same delivery twice through the worker (inferred). Compare only in the tab that issued the request |
| Offline queue, retries | Writes issued offline or after a stream reset are partial (inferred: flush time is not visible beside the SDK) |
| Rules deployed mid-session | A single read at session start cannot see a later deploy. Every comparison older than the latest release check is partial. How the release is rechecked is question 6 |
| Missing App Check token | A misconfigured debug token produces the same "production denied, pyric allows" shape every time, which would pass any repeat threshold. Classified partial, never flagged |
| Token refresh | Partial if a refresh fired in flight (inferred) |

Diffy measured noise by sending each request to two copies of the known-good service (track 6). Pyric cannot add production traffic, so it perturbs the prediction instead: evaluate over the uncertainty set of every input, and call a comparison exact only if every evaluation agrees. A shape is flagged only after several distinct requests disagree the same way under the same release stamp; the threshold is an owner decision.

### Data rules

- Comparisons run in memory on full values. Only a reduced form is ever written, and only on the machine, under `.pyric/` (which inherits the ignore rule in `docs/runtime-captures.md:35`).
- A request shape keeps service and operation, a path template (document ids become `{id}`, or `{auth.uid}` when equal to the caller), auth shape (provider and claim names, no values), field names with type tags, query field and operator with value types, `get()` dependencies marked seen or unseen, whether an App Check token was attached and from which provider, outcomes, the release stamp, and SDK version, transport and plane.
- Names can be data too. Collection ids and field names become stable aliases; map keys become `{key}`. A name the rules spell out may stay literal in the local store, where the comparison needs it.
- Rules are user data, not only the user's code. Production rules often name admin uids and emails (`request.auth.uid == '...'`, `request.auth.token.email == '...'`). So literals in rules are aliased in any export, the same as path segments, and the user reviews the exported rules text before it is written.
- Pyric's own trace holds values (track 7 found `request.resource.data` and `request.auth` inside the p8b trace), so the trace never reaches a sink or an MCP result in live mode, only the shape derived from it.
- Shape-only applies to pyric's MCP results and files. Studio and the app page show production values to anyone who can open them (section 9).
- Nothing leaves the machine until the user exports.

### From a divergence to a committed observation

1. Flag, locally and automatically: exact, stable under perturbation, repeated. Shapes only.
2. Look up the operation's registry row through the conformance model (`packages/conformance/src/conformance-model.ts`). A `diverged-documented` or `bug` row is shown as known and not flagged again.
3. Export, by the user's explicit action: a shape-only repro with minimized rules whose literals are aliased, synthetic values from the type tags, both outcomes and the stamp. No values, tokens, uids or emails. The user sees it before it is written.
4. Triage by the maintainer.
5. Turn it into a rules-corpus scenario (`packages/conformance/rules-corpus/<engine>/`, run by the `rules-firestore` rig against the Rules Test API on the oracle project) or an SDK probe (`packages/conformance/probes/`, run by `oracle-run` on the oracle project under `pyric_oracle/<runId>`). The output is a committed observation.
6. A registry row cites it. A new row is born `unverified` and edits that service's `packages/conformance/assurance-node-counts/<service>.json` in the same change (AGENTS.md item 6).
7. The evidence decides: pyric matches the oracle (the live flag was noise or a project configuration difference), or pyric differs and `docs/conformance/cdd.md` step 6 applies (pin both sides, flip to `diverged-documented`, classify).

A user's project contributes the question, never the answer.

### Offline feasibility

Track 7 ran pyric's own evaluators offline (no network, no credentials) on the inputs and verdicts track 4's probes got from production:

| Check | Result |
| --- | --- |
| Firestore: five single-operation verdicts from P1 under the deployed oracle rules | 5 of 5 match (`probes/p8-offline-verdict-parity.out.txt`) |
| Firestore: P1's mixed batch as the AND of member predictions | Match (deny) |
| RTDB: seven P5 verdicts with the gating node known, including `.validate` and a `root.child` rule | 7 of 7 match |
| RTDB: the gated write with the gating node unseen | False divergence: production allowed, pyric denied. Classification must come before comparison |
| Firestore: does the trace name the documents a verdict read? | Yes: `cfg/site` appears in both the seen and the unseen case (`probes/p8b-get-dependency-trace.out.txt`) |

Limits: the deployed Firestore rules the probes ran under are `if true`, `if false` and `request.auth != null` (`probes/p4b-rules-source.out.txt`), so the Firestore half shows only that the pipeline runs; it says nothing about predicting `resource`, `get()` or list-proof verdicts. The RTDB half is stronger, since it includes `.validate` and a rule that reads another node. The `get()` trace check was offline only. All inputs were synthetic copies of the probe inputs, not live traffic.

## 8. Recommended design

Stated as properties the design must have, with the evidence for each.

**Data path.** SDK pass-through (B). Pyric re-exports the full public surface of each forwarded `firebase/*` module from the app's own installed SDK, on each plane a stage claims: the served import map, Vite, register, and the Node host's remote mode. A live mode is a new row set in the shared swap table (`firebase-module-swap.ts`, which lists 14 specifiers including `firebase/firestore/lite`), not a flag threaded through files, so the planes cannot drift (track 1, section 5; AGENTS.md item 3). `firebase/compat/*` is not in the table; what a compat import does today was not checked, and a live mode must forward-and-document or refuse it.

**The app's Admin SDK.** Refused per call, import-safe, on a live session (section 4).

**App model.** Recommendation, pending question 2: extend the shadow-app pattern main ships for AI and App Check, so the real Firestore, Auth and App Check share one real app object while pyric keeps its runtime and event stream. The parked attempt replaced `firebase/app` outright and lost Studio's feed (track 1, section 2). The parked ownership assertions (`getApp() === app`, `db.app === app`, the snapshot is the real class) carry over as the check that no split app appears (premortem R6). A second copy of `@firebase/app`, one resolved by pyric and one by the app, would break the shadow-app container lookup (inferred), so live mode resolves the SDK from the app's project root, as the parked plugin did. Inferred: this has not been tried for Firestore.

**Supported `firebase` versions.** `firebase` is a devDependency of `@pyric/cli` and `pyric` (`^12.12.0`, `packages/cli/package.json:273`), with no peer range, so pass-through would accept any app version without warning. Recommendation (question 12): live mode declares a supported range and refuses to start outside it.

**Observation.** Wrappers at the public boundary call the real function, return its original result, and record a shape, including on rejection and on listener error. Observations join main's bounded capture and event stream, never a second writer (ledger C3). Every forwarded name is either observed or listed as "forwarded, not observed" in a generated table. A recorder failure must never change what the app sees (gate 7A).

**Verdicts.** A new rules disposition carries production's outcome; a separate `shadow` field carries pyric's prediction, with the labeling rules in section 6.

**Rules.** Read per release: `cloud.firestore` and `cloud.firestore/<databaseId>` for Firestore, `firebase.storage/<bucket>` for Storage. The oracle project alone has five Firestore releases and two Storage releases (`probes/p4-rules-retrieval.out.txt`). Read the release, not the newest ruleset. Until the simulator binds `database`, a non-default Firestore database is refused per call (question 7). Comparisons carry the release stamp; how the stamp is kept fresh is question 6. Without any Rules API read, comparisons run against the local rules file and are labeled "against local rules, deployment not confirmed", which keeps them partial.

**Credentials pyric holds.** Live mode refuses to start with a credential that can read or write data. The intended credential is `roles/firebaserules.viewer`, which grants release and ruleset reads and no `datastore.*` or `storage.*` permissions; it also grants `resourcemanager.projects.get` and `.list`, so a leaked key can list projects (docs.cloud.google.com/iam/docs/roles-permissions/firebaserules). The property is checkable before start, for example by asking Resource Manager's `testIamPermissions` whether the credential holds `datastore.entities.get`, `datastore.entities.update` or `firebasedatabase.instances.update`, and refusing if it does (an option, not verified to cover every data permission). Main's credential resolution falls back to gcloud ADC `authorized_user`, the developer's own identity and often Owner (`cli/src/credentials/node/from-adc.ts:50-62`), and staging verify falls back to the `firebase login` token (`verify/staging/target.ts:101-109`). Both are refused in live mode. Setup options, with tradeoffs, are question 5. RTDB rules need an OAuth token and no confirmed role narrows to rules (track 5), so RTDB rules are left out until one is found.

**Pyric's tools are read-only, structurally.** Two guarantees are kept apart (track 5, section 2). G1, pyric's tools never write production: pyric holds no credential that can write data, and the server refuses every method whose effect is not `read` when the target is live, before any handler runs (the effect field exists on every method record). G2, the app's own writes, is a stage-level choice (section 10, question 9).

**Data stays local.** Shapes in every pyric file and MCP result. In a live session the MCP audit log and capture file record shapes only, since today both store full values (`cli/src/bridge/server/audit.ts`, `cli/src/serve/namespace.ts:286-327`). Pyric reads `uid` and claim names, never token strings. Studio and the app page are value displays and are treated as such (section 9).

**Agents.** Shapes by default; values only through a human opt-in the agent cannot give itself; every result tagged live; the session never switches onto a live target silently (ADR 0016's per-call target switch, `docs/decisions/0016-mcp-session-follows-the-node-host.md`).

**Cost.** Live traffic is billed to the user's project. Live mode shows a per-session count of reads, writes and listener deliveries from its own observations.

**Conformance.** Local exact-or-partial classification, local shape-only candidates, export on user action, oracle capture by a maintainer (section 7).

**What the design refuses to do.** Admin reads of production data, Admin pass-through for the app, impersonation, production deploys, reads made only to sharpen a comparison, the `production` methods and staging engine on a live session, and Studio edits upstream.

## 9. Risks and mitigations

Safety is central: live mode is the first feature that would put production data on pyric's data path (track 5, section 1).

### Credentials present during a live session

| Credential | Where it lives | Who holds it | Risk | Mitigation |
| --- | --- | --- | --- | --- |
| End user's ID token | Real Auth SDK memory, page or Node process | The app | About an hour of the user's authority | Pyric never copies it; reads only `uid` and claim names |
| End user's refresh token | Auth persistence: the dev browser profile's IndexedDB, or the Node process | The app | Long lived; mints new ID tokens until revoked (firebase.google.com/docs/auth/admin/manage-sessions). An agent with a shell can read it from the browser profile, or drive the signed-in page through a browser automation tool | Pyric never copies it. Recommend a dedicated test account in production for live sessions, so a leaked refresh token carries a test user's authority, not a real one. Pyric cannot protect it from a local agent |
| App Check debug token | Registered by the user in the Firebase console; held by the dev page | The user and the app | The debug-provider page says a debug token allows "access to your backend services from unverified devices", so it is a production credential. Registering it is a production console change the user makes | A per-developer token, revoked when no longer needed, never in the repo. Pyric never registers one for the user |
| Rules-viewer credential | A key file outside the project, or a short-lived impersonated token | Pyric | Rules text (which may hold uids and emails) and project listing | Loaded by path, never logged, never echoed into results |
| gcloud ADC `authorized_user`, `firebase login` token | The developer's home directory | The developer | Usually Owner (inferred) | Refused as a live credential; pyric does not fall back to them |
| Pyric session token | Handed to the dev page by `/__pyric/init.json` | Any script in the page | Opens pyric's routes, which now carry production-derived data | Part of the #1325 gate |

### Other risks

| Risk | Where it comes from | Mitigation | Strength |
| --- | --- | --- | --- |
| Accidental production write by pyric's tools | Studio edits, seed and import, MCP `write`/`destructive` methods, verify engines, repro replay on a live target | No data-write credential in pyric; server refuses non-read effects on a live target below the agent; Studio actions refused per action, each with a scenario | Structural if both hold (track 5, section 6) |
| Accidental production write or send by the app during development | An agent edits app code and the dev loop writes production | An app-read-only stage refuses the SDK's write and send names per call. Its holes are documented, not hidden: writes queued in a persistent cache from an earlier session (inferred), RTDB `onDisconnect`, callables, raw REST `fetch`, and the Auth side effects in section 10. A browser network guard may close some holes (section 4, unverified) | Structural for listed names; documented holes |
| Permissive production rules | Production's rules are the boundary for app traffic; track 6's largest Firebase exposures came from permissive rules | Lint the deployed rules (stage 1) and show broad-write findings before any stage that forwards writes (question 13) | Advisory |
| The app's own Admin SDK | Register maps `firebase-admin` today; pass-through would bypass rules | Refused per call on a live session | Structural |
| Read-only only requested, not enforced | `confirm: true` is an argument the agent writes; `--allow-production` sits on a process an agent with a shell can restart (track 5, section 4, inferred) | Enforce in the credential check and in server code. Treat `confirm` as intent only. The `production` methods stay off in live sessions | Only the credential holds against an agent with a shell |
| Target confusion | Developer or agent thinks it is on the sandbox (the PocketOS and Replit pattern, track 6 section 7) | Fail closed: live mode is off unless the human starts it; a visible production indicator in the chip, Studio and every terminal line; `_pyric` mode on every MCP result | Advisory plus fail-closed default |
| Credentials in capture files and repros | Capture is verbatim; the repro redactor keeps JWT claims and does not recognize opaque refresh or OAuth tokens (`cli/src/serve/repro/format.ts:157-226`) | Pyric never copies tokens. Shape-only files in live mode, so redaction is not the defense | Structural if no token is ever copied |
| Production values in the MCP audit log | Full `args` and `result` per call to `~/.pyric/projects/<id>/events.ndjson`, outside the project and unbounded (`audit.ts:1-26`, `bridge.ts:88-118`) | Shapes only in a live session | Structural once in place |
| Production values at rest | The SDK's persistent cache in the dev browser profile or Node process; Studio's view of received documents | Declared as local data at rest. Recommend memory cache by default in live mode unless the app configures persistence (inferred tradeoff with cost, below) | Advisory |
| Agent reads values outside MCP | Through Studio or the app page with a browser automation tool, through dev server routes with curl, or from the SDK cache on disk | Say plainly that shape-only covers pyric's MCP results and files, not pages. Studio's value display is part of the #1325 gate | Partial; a local agent with a shell can read what the user can |
| Agent confirms its own access | Any confirmation that is an HTTP route the agent's process can reach (track 5, section 4) | Value access and write stages enabled only by a flag the human types when starting the dev server, or a page confirmation the agent's process cannot forge (inferred: for example a nonce shown only in the page) | Strongest available on one machine |
| Prompt injection and exfiltration | Production strings are written by end users; tool results reach the agent; the agent's host can call out (the lethal trifecta, simonwillison.net/2025/Jun/16/the-lethal-trifecta/; the Supabase ticket attack, generalanalysis.com/blog/supabase-mcp-blog) | Remove the legs pyric controls: shapes by default, no write path, no credential broader than rules-viewer. Result wrapping is advisory; Supabase found it "reduced risk but did not eliminate it" | Partial by nature |
| Dev server attack surface | Routes that carry observations, captures, MCP, the bridge socket, deployed rules text and Studio's values | The #1325 hunt is open. Live mode raises the stakes of every dev server finding, because the same routes would carry production data. The hunt's results gate the first stage that puts production-derived content on a dev server route, and that stage names the routes so the hunt's contract covers them | Depends on the hunt |
| Cost on the user's project | Every live read is billed: HMR reloads restart listeners and re-read their documents, rules `get()` and `exists()` calls are billed reads, an agent-driven dev loop multiplies traffic, and Auth sends email and SMS (SMS is billed) | A per-session count of reads, writes, deliveries and sends from observations, shown in the chip and Studio. Whether the persistent cache is the default is weighed against data at rest (question 14) | Advisory |
| Confidently wrong explanations | A prediction shown as production's reason; a missing `get()` target read as deny (p8's false divergence); a missing App Check token read as a rules divergence | Labeling rules (section 6); "undetermined" outcome; exact-or-partial classification before any flag | Structural in data shape; editorial in copy |
| Recorder changes app behavior | Wrappers calling `data()`, double converter calls, swallowed errors (premortem R7) | Return original results; record copies; test non-interference per wrapped function with the real SDK classes | Tested |
| SDK version drift and duplicate SDK copies | No peer range; a second `@firebase/app` breaks the shadow app (inferred) | A declared supported range and a start-time check for one `@firebase/app` copy | Tested |
| Served import-map plane cannot reach the real SDK | Main's served bundler keeps `firebase/*` external; how production AI mode reaches the real `firebase/app` on that plane was not found (track 1, open question 2) | That plane is a documented refusal until its resolution is shown | Unknown |

## 10. A staged path

Each stage is a capability that stands on its own against D3: it forwards the full surface of what it touches, and everything else is refused per call, import-safe, with a scenario. Whether one scenario may cover a group of refused names with the same behavior, or each name needs its own, is question 1. Whether a stage may refuse a whole plane is question 2. How a scenario answers Firestore's streams without a production call is question 3; until that is ruled, the stages below are described by what they forward and refuse, and their acceptance is stated in terms of what a scenario must observe.

### D1 surface categories by stage

| D1 category | Stage 1 | Stage 2 | Stage 3 | Stage 4 |
| --- | --- | --- | --- | --- |
| One-shot reads, queries, aggregates | Not live (sandbox) | Forwarded, observed | Same, plus prediction | Same |
| Document and query listeners | Not live | Forwarded, observed | Same, plus prediction | Same |
| Writes, batches, transactions | Not live | Refused per call | Refused | Forwarded, observed, by human flag |
| Converters, metadata options | Not live | Forwarded; observed through the read they wrap | Same | Same |
| Network controls (`enableNetwork`, `disableNetwork`, `terminate`) | Not live | Forwarded, not observed; they act locally | Same | Same |
| Cache controls (`clearIndexedDbPersistence`, persistent cache settings, `loadBundle`, `namedQuery`) | Not live | Forwarded, not observed; they act on local data at rest. `loadBundle` loads data from the app's own server into the cache (inferred: no Firestore call) | Same | Same |
| `waitForPendingWrites` | Not live | Forwarded; resolves with nothing pending in a read-only app (inferred) | Same | Forwarded, observed |
| `firebase/firestore/lite` | Not live | Reads forwarded and observed; writes refused per call | Same, plus prediction | Writes forwarded by flag |
| Named databases (`getFirestore(app, databaseId)`) | Not live | Refused per call until the simulator binds `database` | Same | Same |
| `firebase/compat/*` | Not checked | Refused, or forwarded and documented, once checked | Same | Same |

### Stage 1: deployed rules, no app data

- Forwards: nothing from the app, which stays on the sandbox. Pyric reads the released Firestore and Storage rules per release with a rules-only credential that passes the start-time check.
- Gives: lint on the deployed rules, including broad-write findings; a diff between local and deployed rules; shadow evaluation of hand-built cases against what production serves.
- Refuses: every app data path, any rules deploy, any data read, ADC and `firebase login` as credentials.
- Acceptance: a scenario through the `pyric` command shows a recorded Rules API answer read per release with its stamp, no data host contacted, and a data-capable credential refused at start.
- Hunt gate: rules text can hold uids and emails, and this stage puts a production credential in the dev server process. Recommendation (question 8): it waits for the hunt's results on the routes that would serve rules text.

### Stage 2: observed Firestore reads and listeners, app read-only

- Forwards: the full `firebase/firestore`, `firebase/auth`, `firebase/app` and `firebase/app-check` surfaces by re-export, on each plane the stage claims, per the category table above.
- Auth side effects: forwarding Auth in full forwards calls that change production or reach real people. `createUserWithEmailAndPassword` and `signInAnonymously` create real accounts; `deleteUser` deletes one; `updateProfile`, `updateEmail`, `updatePassword`, `linkWithCredential` and `unlink` change one; `sendPasswordResetEmail`, `sendSignInLinkToEmail` and `sendEmailVerification` email real people; `signInWithPhoneNumber` sends a billed SMS. Recommendation (question 10): refuse each per call in this stage, keep sign-in of existing accounts forwarded, and treat account creation by sign-in as an owner choice.
- Refuses, per call: Firestore write names (`setDoc`, `updateDoc`, `deleteDoc`, `addDoc`, `writeBatch`, `runTransaction` and siblings), the Auth calls above, non-default databases, every `firebase-admin` call under register, every other service (RTDB, Storage, Functions callables, Messaging, Analytics, Performance, Remote Config). Mixing real Auth with sandbox services is not offered (inferred: it would show a sandbox result under a real identity). All pyric tool writes and Studio edits are refused. The documented holes of an app-read-only mode are listed with it.
- Gives: Studio traffic with production outcomes, the denial overlay and terminal block, the listener chip, the partial data browser, MCP shapes, the per-session cost count.
- Acceptance: on each claimed plane, a real-SDK read and a denied read appear in Studio and the terminal with production's code, the app's ownership assertions hold, and each refused call throws its pyric refusal with zero upstream requests.
- Hunt gate: yes, production values now reach dev server routes and Studio.

### Stage 3: shadow evaluation and conformance candidates

- Adds: per-request prediction with the labeling rules, exact-or-partial classification from the trace, the local shape-only candidate store, the known-row lookup, and the user-initiated export with aliased rules literals.
- Refuses: Admin read-back, Rules Test API calls on the user's project, any export without the user's action.
- Acceptance: a matching denial, a disagreeing denial, an undetermined one (missing `get()` target) and one with no App Check token are each labeled correctly in Studio, the terminal and MCP output, and an export contains no values, tokens, uids or emails.

### Stage 4: app writes forwarded, by human opt-in

- Forwards: Firestore writes, batches and transactions (and lite writes), observed, enabled by a flag the human sets when starting the dev server, after the deployed rules' broad-write lint has been shown. Pyric's tools stay read-only.
- Refuses: everything stage 2 refuses outside Firestore writes, plus every MCP write method and Studio edit, each with its scenario.
- Acceptance: a write shows production's ack, a denied batch shows as one outcome, and without the flag every write is refused with zero upstream requests.

### Later stages: RTDB, then Storage

Each repeats stages 2 to 4 for one service, with the same rule. RTDB needs the engine to report the nodes a rule read (today the live layer would have to parse expression text, track 7) and possibly a lazy subtree lookup. Storage reads rules per bucket.

## 11. Open questions for David

Collected from the tracks and the review, merged, and kept to those that block a design decision. Each has a recommendation.

1. **D3 granularity: does a refusal need a scenario per refused operation, or may one scenario cover a group with the same behavior?** D1's acceptance reads "per-operation refusals each backed by a scenario". Recommendation: one scenario per group, where a group shares one refusal path and the scenario enumerates every name in it and asserts each throws with zero upstream calls. That keeps "each refusal" true by assertion without one app per name. This is a reading of D1 for you to rule on, not an assumption.

2. **Does D3 accept "full re-export, some functions observed, the rest documented", and may a stage refuse a whole plane?** A full re-export forwards everything, so observation gaps are a tool-coverage matter. A plane refusal is not a per-operation refusal. And the shadow-app answer may differ by plane (the served import map is unsettled). Recommendation: yes to the first, with a generated table of forwarded-not-observed names and D3's refusal rule applied to every surface a stage changes, including refused MCP methods and Studio actions. Yes to plane refusal only if the refusal is a startup error with its own scenario, so no app runs partly live on that plane.

3. **How does a stage's scenario answer Firestore's streaming RPCs, and does that count as a real entry point?** Options: a recorded WebChannel and gRPC replay server in tests; `firebase/firestore/lite` (REST, answerable by a route) as the first observed surface; real calls to the oracle project in a slow scenario, which the harness rule "no scenario reaches a Google or Firebase production endpoint" (`test/apps/README.md:8`) forbids today. Recommendation: slow scenarios against the oracle project for the streaming paths, as the evidence of record, since a replay of undocumented framing would itself be an unverified model and item 7 treats a faked socket as unit evidence; route-answered lite scenarios on pull requests. This needs your ruling on the harness rule.

4. **What credential does live mode hold, and how is "no data access" enforced?** Recommendation: none for data; only a rules-viewer credential, checked at start (for example through `testIamPermissions`) and refused if it can read or write data. ADC and `firebase login` are refused. RTDB rules wait for a narrower role.

5. **How does a user get the rules-viewer credential?** Options: a short-lived token through service account impersonation (needs `iam.serviceAccounts.getAccessToken` for the developer and works where key creation is blocked by org policy, inferred), a key file outside the project (simple, long lived, often blocked by policy), or ADC (refused). Recommendation: impersonation first, key file second.

6. **Reading the deployed rules, and keeping the stamp fresh.** Is one read per session allowed under #1394, and how is a mid-session deploy detected? Options: re-read the release metadata (not the ruleset) on a low cadence; re-read when the local rules file changes; re-read only before a flag or an export; or mark every comparison older than the read as partial. Recommendation: allow the session read (it serves explain and lint, not only comparison); re-read release metadata on local rules file change and before any flag is shown, and fetch the ruleset only if the release changed. A release read before a flag is closer to "added only for comparison", so if you rule it out, fall back to marking stale comparisons partial and re-reading only at export, which is a user action.

7. **Named databases.** Recommendation: refuse `getFirestore(app, databaseId)` for a non-default database per call until the simulator binds `database`, then forward it with rules read from `cloud.firestore/<databaseId>`.

8. **Does stage 1 wait for the #1325 hunt?** It puts a production credential in the dev server process and rules text, which may hold uids and emails, on dev server routes. Recommendation: yes, for the routes that serve rules text.

9. **Is the first app-facing stage read-only for the app?** Recommendation: yes, with the holes listed. Probe the browser network guard (section 4) as a backstop before claiming more than named functions.

10. **Auth side effects in a read-only stage.** Recommendation: refuse account creation, deletion, profile changes and email or SMS sends per call; forward sign-in of existing accounts. Anonymous sign-in creates an account on first use, so it is an owner choice: forward it as a documented exception if the app needs it to read at all.

11. **Is Admin pass-through ever offered for the app's own `firebase-admin`?** Recommendation: no. Refused per call on a live session; a server that needs Admin runs outside register.

12. **Does live mode declare a supported `firebase` range?** Recommendation: yes, and refuse to start outside it or with two copies of `@firebase/app`.

13. **Should live mode warn when production rules or the signed-in user's claims allow broad writes?** Recommendation: yes, from the deployed-rules lint, shown before the write stage can be enabled.

14. **Does an on-demand Admin read to explain one denial count as a user action?** Tracks disagree: track 3 sees a narrow opt-in read as the way to explain most denials; track 7 reads it as a production call added for comparison; track 5 allows it only behind a human confirmation. It needs `roles/datastore.viewer`, which reads every document and bypasses rules, and it conflicts with question 4. Recommendation: not in these stages. Show "undetermined" with the missing inputs named, measure how often that happens in stage 3, and decide then.

15. **MCP defaults and cost defaults over live data.** Recommendation: shapes by default; values only if the human enabled them for the session at server start, scoped to named paths; every result tagged live; audit log shape-only; ADR 0016's target switch never lands on a live target mid-session. For cost, memory cache by default unless the app configures persistence, with the per-session count always shown.

16. **App model.** Shadow real app beside pyric's app, or the real `firebase/app` outright? Recommendation: the shadow app, with the parked ownership assertions as the guard against a split, claimed per plane.

17. **Flag threshold and repro content.** Recommendation: decide after stage 3 has data; start with minimized rules with aliased literals, shown to the user before writing, since a digest alone cannot be reproduced on the oracle.

Technical unknowns that do not block the design but must be answered before the stage they touch: whether an App Check rejection is distinguishable from a rules denial (track 4); whether a Firestore listener is cancelled when its `get()` dependency changes (track 4); what the browser build sees on denial (track 4); whether a persistent cache flushes queued writes when a read-only client starts (track 5); what a `firebase/compat/*` import does under the swap table; whether the Cloud Monitoring rules metric exists and what it labels; whether `spike/live-mode-firestore` (`824d8f5b`, with the lost recorder and explainer) survives on another machine (track 1).

## 12. Review

An independent adversarial review challenged the first draft of this report (22 findings: 2 blockers, 11 major, 9 minor). The points that changed it:

- The stage evidence plan relied on replaying Firestore's streams from captures, which is the decoding cost the draft held against the wire proxy. Section 4 now counts CI evidence cost for each path and explains why the rejection of A still stands, and question 3 asks how streaming scenarios are answered.
- The app's own `firebase-admin` under register was missing. It is now refused per call, with question 11.
- The credential claim covered only pyric's code. Section 9 now inventories every credential in a live session, including the refresh token, the App Check debug token (a production credential, and a console change to register) and the ADC fallback, which is refused.
- "Read-only" stage 2 forwarded Auth's account, email and SMS side effects, `firestore/lite` and the network and cache controls without saying so. Stage 2 now names each, and section 10 maps every D1 category per stage.
- Named databases, multiple releases and mid-session rules deploys were missing. Rules are read per release, and named databases are refused per call (questions 6 and 7).
- Rules literals, Studio values and billing on the user's project were missing. Exports alias rules literals, Studio is declared a value display, and cost is a risk with a per-session count.
- The prior-art claim was overstated, and the offline parity result was stronger in the draft than its rules support. Both are corrected.
- D3 granularity is now put to the owner as question 1 instead of assumed.

Declined: the review counted 57 `write` and 7 `destructive` effects by grep; the extra one of each is a heading list in `bridge/surface/tool-description.ts`, not a method, so the method counts stay at 56 and 6, and the three `production` methods are now named. The review also cited release plan rule 7 for billing; that rule is about the project's own agent and test quota, not the user's Firebase bill, so the cost risk stands on its own.

## 13. Sources

### Repo

- Main at `66e7a7f53` (this document); tracks read main at `dddc74a36`. Track 7's offline probes imported pyric source from a local main checkout at `3d49b23ce`.
- `PRIORITIES.md`, "Live mode" (merged in #1394).
- `AGENTS.md`, items 3, 6, 7; `test/apps/README.md:8`.
- `docs/hosted-release-plan.md:45` (D3), `:166`; `docs/hosted-review-ledger.md:272-274` (D1), `:328` (section E), section C3.
- `docs/conformance/cdd.md`, steps 2, 4, 6; `docs/runtime-captures.md:35`; `docs/decisions/0016-mcp-session-follows-the-node-host.md`.
- `packages/cli/test/cli/ledger/d3-live-removal.test.ts`; `packages/cli/test/serve/entries/ledger/i20-served-public-exports.test.ts`.
- `packages/cli/src/serve/firebase-module-swap.ts:21-36, 67-79`, `serve/entries/unsupported/call.ts`, `serve/entries/firestore-lite.ts`, `serve/entries/app-ai-passthrough.ts`, `serve/worker/ai-observation.ts`, `serve/namespace.ts:286-327`, `serve/repro/format.ts:157-226`.
- `packages/cli/src/register/mapping.ts:26-30, 73-78`, `register/app-bridge-shadow.ts`, `register/app-bridge-app-check.ts`, `register/net-guard.ts`.
- `packages/cli/src/bridge/surface/method-effects.ts`, `bridge/surface/tool-description.ts:44-48`, `bridge/surface/methods/{storage/status,storage/provision,assurance/testRulesHosted}.ts`, `bridge/server/audit.ts`, `bridge/server/bridge.ts:88-118`, `bridge/surface/rules-simulation.ts`.
- `packages/cli/src/credentials/node/from-adc.ts:50-62`; `packages/cli/src/verify/cases.ts:96-107`, `verify/staging/target.ts:101-109`.
- `packages/cli/package.json:273`.
- `packages/pyric/src/sandbox/types/events.ts:129`, `sandbox/types/operation.ts:46`, `sandbox/internal/sdk-activity.ts`, `rules/simulator/handler.ts:491-500`, `rules/simulator/document-lookups.ts:18-21`, `rules/inspect/handler.ts:14-46`.
- `packages/studio/src/features/traffic/verdict.ts:56-66`.
- `packages/conformance/src/conformance-model.ts`, `rules-corpus/`, `probes/`, `rigs/rules-firestore.ts`, `rigs/oracle-run.ts`, `registry/`, `assurance-node-counts/`.
- `test/apps/ai-production-app-check/scenario.ts:28-43`.
- Parked work: `origin/live/parked` `2751e1d7b`, `origin/hosted-live-mode` `26a6ae0d6`, merge-base `f7e90081b`, live code `4b2ae8814`, removal `140394368` (on `origin/hosted-main-integration`). Related main commits: `9ec53e1fe` (#653), `df408728b` (#671), `5807259eb` and `86ce56983` (App Check pass-through). Missing: `spike/live-mode-firestore` `824d8f5b`.
- SDK builds read by track 2 under the repo's `node_modules/.bun/`: `@firebase/firestore` 4.14.1 (`dist/common-7a7519be.esm.js`), `@firebase/database` 1.1.3, `@firebase/storage` 0.14.3, `@firebase/auth` 1.13.1, `@firebase/app-check` 0.11.3, `@google-cloud/firestore` 7.11.6.

### Probes

| Probe | What it shows |
| --- | --- |
| `p1-firestore-denial` | Firestore denial codes, messages, batch and transaction behavior, REST envelopes |
| `p2-firestore-listener-metadata` | Listener metadata and write-ack ordering |
| `p4-rules-retrieval`, `p4b-rules-source` | Deployed rules retrieval with a service account versus a client; the releases on the oracle project |
| `p5-rtdb-observability` | RTDB denials, a rule that reads another node, listener revocation, timing |
| `p7-timing-and-storage` | Timing, Storage denial shape, resume token layout |
| `p8-offline-verdict-parity`, `p8b-get-dependency-trace` | Offline: pyric's evaluators against production's verdicts; dependency names from the trace |

The probes are not committed; they ran against the oracle project with its service account, and the offline ones ran with no network or credentials. The production probes ran on a saturated machine, so their timings are upper bounds (track 4, "Timing").

### Web

Firebase and Google Cloud:
- https://firebase.google.com/docs/firestore/use-rest-api
- https://firebase.google.com/docs/firestore/security/iam
- https://firebase.google.com/docs/firestore/security/get-started
- https://firebase.google.com/docs/firestore/manage-data/enable-offline
- https://firebase.google.com/docs/firestore/using-console
- https://firebase.google.com/docs/rules/simulator
- https://firebase.google.com/docs/reference/rules/rest
- https://firebase.google.com/docs/reference/rest/database
- https://firebase.google.com/docs/database/rest/app-management
- https://firebase.google.com/docs/database/admin/start
- https://firebase.google.com/docs/storage/security
- https://firebase.google.com/docs/app-check/web/debug-provider
- https://firebase.google.com/docs/auth/admin/create-custom-tokens
- https://firebase.google.com/docs/auth/admin/manage-sessions
- https://firebase.google.com/docs/emulator-suite/connect_firestore
- https://firebase.google.com/docs/ai-assistance/mcp-server
- https://firebase.google.com/docs/projects/iam/roles-predefined-product
- https://firebase.blog/posts/2019/03/firebase-security-rules-admin-sdk-tips/
- https://docs.cloud.google.com/iam/docs/roles-permissions/firebaserules
- https://docs.cloud.google.com/firestore/native/docs/use-firestore-mcp
- https://docs.cloud.google.com/firestore/docs/use-pitr

Prior art and incidents:
- https://www.firefoo.com/
- https://supabase.com/docs/guides/getting-started/mcp
- https://github.com/supabase-community/supabase-mcp
- https://supabase.com/blog/defense-in-depth-mcp
- https://www.generalanalysis.com/blog/supabase-mcp-blog
- https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- https://simonwillison.net/2025/Jul/6/supabase-mcp-lethal-trifecta/
- https://simonwillison.net/2025/Jul/26/official-statement-from-tea/
- https://www.postgresql.org/docs/current/pgstatstatements.html
- https://opentelemetry.io/docs/specs/semconv/database/database-spans/
- https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/
- https://github.com/twitter-archive/diffy
- https://github.com/github/scientist
- https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/route/v3/route_components.proto
- https://istio.io/latest/docs/tasks/traffic-management/mirroring/
- https://emulate.dev and https://emulate.dev/docs
- https://www.eweek.com/news/replit-ai-coding-assistant-failure/
- https://www.bytebase.com/blog/how-to-prevent-ai-agent-from-dropping-your-production-database/
- https://oecd.ai/en/incidents/2026-04-27-6153 (outcome only; the mechanism rests on secondary coverage)
- https://www.theregister.com/2024/03/18/google_firebase_cloud_security/
- firebase-tools MCP source read through the GitHub API: `src/mcp/onemcp/index.ts`, `src/mcp/tool.ts` at `926b3fe846`; `src/mcp/tools/firestore/delete_document.ts` at `43960d5037`, removed in `9dd6032d6f`.
