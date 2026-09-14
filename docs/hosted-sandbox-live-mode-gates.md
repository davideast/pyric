# Mechanical gates: hosted sandbox and live mode

Date: 2026-09-12. Applies to the [sequence](hosted-sandbox-live-mode-sequence.md) and [premortem](hosted-sandbox-live-mode-premortem.md).

Status: gate specification. This document does not install a checker or claim implementation tests passed. Existing commands are identified separately; the hosted/live checks below must be implemented before their corresponding subsection can be completed. The live spike is not the implementation baseline.

## Advancement rule

A subsection can be marked complete, and dependent implementation can proceed, only when its prerequisite gates, universal gates, and local gates pass against the same input revision. Independent work may continue. At a section join, the composed system must pass its integration gates; several passing subsection reports do not establish integration.

Every executable gate needs an ID, dependency IDs, an exact command and working directory, expected scenario IDs, assertions, applicable configurations, and evidence. Evidence records exit status, collected/executed/passed/skipped scenarios, source and test input digest, lockfile/toolchain identity, built artifact digest where applicable, and a bounded report. A command exiting zero is necessary, not sufficient.

Missing tests, skipped required scenarios, test-load failures, missing browsers, timeouts, stale builds, retry-only passes, undefined performance budgets, and handwritten “passed” evidence do not pass. A required scenario marked not applicable must correspond to an explicit unsupported configuration and a passing refusal test; it cannot be an unexplained exemption. Gate definitions are reviewed before implementation and cannot be weakened to clear a failure without recording a changed requirement.

Use a small completion script and the existing CI/reporting machinery. Do not build an orchestration framework for these gates. The unlazy CHECK/EXPECT format can represent runnable leaf ledgers once commands exist, but its definition digest alone does not bind source or artifact changes; current-input verification still needs to be performed.

## TDD admission and cycle evidence

Follow the [plan's TDD method and proposed seams](hosted-sandbox-live-mode-sequence.md#execution-method-tdd-at-agreed-seams). Acceptance outcomes are specified up front; executable tests are written one behavior at a time. Do not bulk-author imagined implementation tests to fill this catalog.

| ID | CHECK | EXPECT |
| --- | --- | --- |
| T0 — agreed seam | Before writing a new test, resolve its seam and scenario scope to the recorded user agreement. | The seam is explicitly confirmed. A proposed seam or permission to edit planning documents does not count. Existing confirmation is reused. Recording agreement is a human prerequisite, not something a test can infer. |
| T1 — red evidence | Run the single new behavior test against the pre-implementation state and retain its assertion failure, command, test digest, and source identity. | Failure demonstrates the selected missing behavior. Setup errors do not count. A verifier of red evidence succeeds by verifying the expected test failure; it must not mistake the failing test's exit code for a completed feature. |
| T2 — green evidence | Run the same behavioral assertion against the minimal implementation, then the affected universal checks. | The test passes without weakening its expected outcome or substituting mocks of internal collaborators. Changing the behavior under test requires a new valid red observation. |
| T3 — review-stage verification | After any separate behavior-preserving refactor, rerun the confirmed seam tests and affected structural/regression checks. | Green behavior remains green; no new unconfirmed test seam or speculative feature enters through cleanup. A new behavior starts a new red → green cycle. |

Red evidence is intentionally historical and binds to the pre-implementation source. Green and completion evidence bind to the current candidate. Neither supersedes the other. Already-supported characterization tests and existing regressions may begin green; label them as baseline evidence rather than inventing a failure. The catalog may contain several outcomes in one row; work through their tests sequentially, then run the complete set at the subsection exit.

TDD behavior tests observe agreed caller interfaces. Do not mock private collaborators, assert internal call order, or query internal maps as a substitute for an SDK-visible result. Resource measurement and deliberate transport/filesystem faults use the agreed external or diagnostic seams. AST/import-graph checks inspect source by design, but they are separate development-tool gates and do not authorize implementation-coupled product tests.

## Universal gates: every implementation subsection

| ID | CHECK | EXPECT |
| --- | --- | --- |
| U1 — runnable evidence | Collect the named scenarios, then run them in the declared environment. | Every required scenario is collected and executes once successfully; no missing dependencies, required skips, unexpected test-process errors, or hidden retries. |
| U2 — TypeScript | Run strict typechecking for affected production packages and a dedicated type-test project for affected SDK adapter/contract fixtures. | Zero diagnostics. Type assertions cannot manufacture adapter compatibility. The CLI production tsconfig excludes tests, so running it alone does not check type fixtures. |
| U3 — code form | Run a TypeScript-AST checker over newly added or modified functions and new files, with known-good and known-bad checker fixtures. | Named boolean branch decisions; no nested ternaries, conditional object spreads, logical-expression statements used for side effects, unexplained double assertions, new explicit `any`, non-null assertions, or new suppressions. Narrow foreign-SDK exceptions are individually recorded and tested. |
| U4 — architecture | Check the scoped import graph and bundle inputs; compare source files against the agreed ownership map. | No new dependency cycles or forbidden host/Node/engine imports in browser leaves. No transport/mode decision added to SDK operation modules outside the designated selection/adapter modules. Changed files remain within the declared scope or that scope is explicitly revised. |
| U5 — behavior | Run the subsection's incrementally authored tests at confirmed seams and the affected existing regression suite. | The observable contract holds, including its error path. New behavior/fixes have T1–T2 evidence. Baseline characterization and separate review-stage refactors are identified honestly. |
| U6 — resource lifetime | Exercise close/dispose and interrupted initialization where the subsection allocates resources, observing agreed external or diagnostic interfaces. | Owned resources return to their recorded baseline; no callbacks after disposal; repeated disposal is safe. Use external handle accounting or an agreed diagnostic interface where GC cannot provide a deterministic assertion; do not inspect private registries. Pure leaf modules need no artificial lifecycle test. |
| U7 — freshness and completeness | Validate evidence against current source/tests/config/lockfile and any built artifact; verify prerequisite reports. | No stale dependency evidence or unfinished required gate. A new edit invalidates affected reports. At merge, verify the integration result for the actual candidate revision. |

The U3 source-form and boolean-type checker, command tests, and required build-job wiring now exist; current evidence belongs in the implementation ledger. The conventions apply named decisions to new files and modified TypeScript statements/functions, leaving unchanged legacy statements as explicit exclusions. Boolean conditions in `if`, loop tests, ternaries, and conditional rendering must read named boolean variables rather than inline comparisons or combinations. Already-named boolean variables need no alias. Decompose a long decision into domain facts close to the branch. Recompute loop conditions at the appropriate point; do not auto-hoist expressions across iterations, guards, or `await`. The CLI resolves imported decision types after workspace packages build; unresolved or non-boolean condition types fail. Tests of behavior remain necessary because AST and type checks cannot prove correct evaluation timing.

Existing generated code, third-party code, and unchanged legacy functions need an explicit scope exclusion, not a growing blanket allowlist. New files obey the repository's 600-line source trigger and responsibility rules; a large legacy file may receive a bounded edit without requiring unrelated cleanup. Line count cannot prove that a module has one responsibility.

Mechanical checks cannot establish whether a name explains intent or an abstraction is necessary. Keep a short design review for those judgments; do not label it an automated pass.

U4's browser leaf command and required CI wiring now exist. The [ownership map](hosted-sandbox-live-mode-ownership.md) declares five entries and byte budgets, including the RTDB listener adapter that the older worker barrel does not export. The command inspects emitted contributors and remaining imports; source cycles, selection boundaries, and complete ownership accounting still require verification. Passing these bundle checks alone does not complete U4.

## 0. Preconditions and early proofs

These precede broad implementation of the numbered sequence. Experimental proof code may implement a minimal adapter; it is not permission to declare the production adapter complete.

| ID | CHECK | EXPECT |
| --- | --- | --- |
| 0A — baseline | Install the locked dependencies, build prerequisites, collect and run the existing worker/bridge/value-codec suites below. Record existing failures separately. | Required baseline scenarios run. Dependency-load failures are resolved, not classified as product behavior. No new gate silently relies on an unavailable baseline. |
| 0B — support contract | Validate a configuration manifest with host, execution owner, project/database scope, identity source, persistence owner, and supported operation/control families. Generate a coverage report against scenario IDs. | Every claimed configuration has named scenarios. Unsupported combinations have explicit refusal behavior. Admission, acknowledgment, retention, and performance policies have concrete values before their dependent work begins. |
| 0C — hosted app proof | Run a real served fixture in two isolated browser contexts against one minimal Node host. Delay init; make it fail; occupy the old discovery address with another project. | Both contexts observe one instance and cross-context updates. Startup failure creates no alternative local database. Wrong-project attachment is refused. |
| 0D — real SDK ownership proof | Run one instrumented SDK read through Vite resolution/optimization and the served import-map entry. Use real App/Auth/Firestore objects against an isolated test backend. | The selected real SDK executes exactly once; the intended App/Auth instance owns it; the recorder observes once. No mirror recursion, duplicate SDK initialization, or unresolved dynamic import. A fake function-call counter alone does not prove module resolution. |

## 1. Transport characterization harness

| ID | CHECK | EXPECT |
| --- | --- | --- |
| 1A — current contract | Drive the real client barrel through `portPair()` and through a JSON-round-trip port. Cover config, ops, subscriptions, structured errors, auth, tenant, teardown, and current durability. | Every supported service family is represented. Results agree with the contract, not just each other. Assert special-value behavior, rules outcomes, and observer sequences. |
| 1B — harness can catch faults | Introduce controlled bad adapters that drop a frame, corrupt a special value, reorder sign-in/write, or forward a stale callback. | The intended assertions fail for each fault; the correct adapter passes. Fault adapters never become shipping implementations. |
| 1C — real socket extension | Run the same applicable scenarios over the production WebSocket adapter when it exists. | Socket scenarios cannot be marked passed by reusing the JSON-loopback factory. Trace identifies the adapter and host actually used. |

1A–1B unlock codec and lifecycle implementation for the agreed behavior being changed; extend the harness incrementally with each next slice. Do not build every possible service test before implementing the first slice. Their full declared scenario set is required at the section exit. 1C gates socket section completion, not initial harness work.

## 2. Wire encoding, validation, and errors

| ID | CHECK | EXPECT |
| --- | --- | --- |
| 2A — value fidelity | Round-trip actual SDK values through request → host operation → reply/event → capture. Include timestamps, bytes, locations, references, supported vectors, nested arrays/maps, non-finite numeric values, and marker-like user objects. | Supported semantics and identity fields are preserved; unknown/invalid values follow the declared contract. Rules comparisons and ordering see the intended value type. A JSON string equality assertion alone is insufficient. |
| 2B — write intent | Exercise nested transforms, dotted updates, merge and mergeFields, null, missing fields, and the declared undefined policy. | Encoding never executes a transform. Host execution applies it once. Capture represents intent separately from observed state. |
| 2C — inbound validation | Send malformed envelopes/payloads, incompatible versions, wrong-session frames, oversized and deeply nested values while a second client works. | Failure is bounded and reaches the right requester; no host crash, invalid dispatch, unauthorized execution, or hung unrelated client. Validate payloads after parsing JSON. |
| 2D — bytes and bundle cost | Test binary limits at below/equal/above the boundary, all padding remainders, empty input, and the browser fallback without Buffer. Inspect built client imports and bytes. | Node/browser results agree; getBlob/getDownloadURL retain the advertised shapes; decoded and encoded size limits are consistent; forbidden engine/Node imports are absent and the predeclared bundle budget passes. |

## 3. Connection lifecycle and host runtime

| ID | CHECK | EXPECT |
| --- | --- | --- |
| 3A — ordering | Use deterministic barriers to delay sign-in, mutation, and cleanup; issue concurrent work from a second consumer. | Per-consumer ordering holds. Teardown cannot overtake accepted work. An unrelated consumer is not blocked behind a stalled upstream request. |
| 3B — reconnection | Disconnect before send, during execution, and after commit before acknowledgment. Reconnect with a new generation; deliver old callbacks. | Unsent calls fail according to contract; uncertain writes are not replayed; stale responses are ignored; auth/tenant/lens restoration precedes data subscriptions and dependent operations. |
| 3C — authority and deletion | Duplicate attach IDs, forge a target session, close the old socket after replacement, explicitly delete the app, and restart the host. | Session access follows the admission policy. Old cleanup cannot erase new state. Deletion and temporary interruption remain distinct. Supported resume cannot bypass intentional deletion. |
| 3D — RTDB and global changes | Exercise dropped sockets without clean close, expiry, goOffline/goOnline, reset/import, and checkpoint restore with active listeners. | Connectivity and onDisconnect work follow the declared transitions exactly once where promised; old-generation work cannot repopulate reset state; affected observers and handles refresh or fail explicitly. |
| 3E — disposal | Fail each boot stage and close during initialization; dispose twice and restart. | No orphan ports, event subscriptions, timers, upstream handles, or persistence writers; clean restart uses one runtime. |

All 3A–3E gate production host integration. A transition table is an input to these tests, not evidence that they pass.

## 4. Node host and authoritative persistence

| ID | CHECK | EXPECT |
| --- | --- | --- |
| 4A — single authority | Start two real processes against the same canonical project/state directory; connect remote consumers and MCP; attempt browser peer replacement. | Exactly one writer owns the state. Other processes attach or refuse without mutating it. All clients observe the same host; browser registration cannot replace it. |
| 4B — restore completeness | Write each service advertised as durable, plus checkpoints and identity metadata; terminate and restart the process. | Advertised data restores before seeding and before accepting operations. Credentials and per-port secrets do not appear in persistence. Test values as well as counts. |
| 4C — persistence failures | Inject disk-full/permission failures, corrupt state, interrupted commits, competing flushes, and reset during flush. | Acknowledgment and persistence-health outputs match the chosen contract. No silent overwrite of recoverable data; no stale flush resurrects reset data. Verify process-crash claims without implying untested power-loss guarantees. |
| 4D — Node entry | Boot the actual CLI host under supported Node runtimes with browser globals absent. | Operations, hot reload, capture, and shutdown function through Node dependencies. The implementation does not accidentally require a browser fetch base, IndexedDB, or SharedWorker. |

## 5. Browser WebSocket transport

| ID | CHECK | EXPECT |
| --- | --- | --- |
| 5A — normal SDK path | Run the served application using public SDK imports in isolated profiles, including named-app behavior and every advertised service family. | Shared data and isolated session behavior match the support manifest. Refs/queries/overloads cross the actual socket path. No hosted database is stored in browser persistence. |
| 5B — startup and addressing | Test slow/failed init, expired discovery, HTTPS/proxy addressing, declared LAN access, IPv4/IPv6, and configuration mismatch. | Correct endpoint and project selected; no fallback store; no indefinite readiness promise; failures identify the failed stage. |
| 5C — compatibility and regression | Run 1C, the applicable 3-series interruption scenarios, current/old supported remote clients, and existing in-page/SharedWorker scenarios. | No supported topology regresses; incompatible protocol fails before executing data work; missing optional capabilities follow their specified behavior. |

Steps 4–5 permit a limited preview only after their gates pass. They do not claim full hosted Studio or live support.

## 6. Events, capture, runtime diagnostics, and Studio

| ID | CHECK | EXPECT |
| --- | --- | --- |
| 6A — stream correctness | Attach after history exists; race history/live delivery; reconnect; duplicate producer sequences; reset while old events are pending. | No unexplained gaps or duplicates. Producer/session/generation identity prevents collisions and stale resurrection. Arrival order is not mislabeled backend commit order. |
| 6B — retention and responsiveness | Sustain the predeclared workload, stall a consumer, saturate queues, and keep another client issuing operations. Measure host history, queues, capture size/age, memory, and response latency. | Every retained structure stays within its configured bound; overflow follows contract; capture meets its maximum delay; unrelated work meets the recorded latency budget. Missing budgets or a test too short to reach configured limits fail. |
| 6C — user inspection and privilege | Open Studio and the runtime chip, trigger an operation/error/identity change, and query them as an ordinary app consumer. | UI shows the actual target and current connection stage; inspectable state matches the host; privileged observations and controls follow admission policy; diagnostics remain usable after faults. |

Include 6A–6C in the normal hosted release, not just a later UI milestone.

## 7. Live recording core

| ID | CHECK | EXPECT |
| --- | --- | --- |
| 7A — non-interference | Compare instrumented and uninstrumented executions using actual SDK objects: converters, metadata events, supported overloads, thrown observer errors, and a failed recorder. | Same upstream call count and application-visible behavior under the stated contract. Recording failure cannot change a committed write into a reported write failure. Converter/getter behavior is preserved or unsupported behavior is explicitly rejected. |
| 7B — honest evidence | Exercise unknown/absent/present state, partial writes, transforms, cache deliveries, limited query changes, identity switches during await, and rules changes after a request. | Events preserve source and original identity; estimates never become observations; replay/explanation names missing or stale context and does not claim a proven backend decision from cache data. |
| 7C — surface and policy | Enumerate supported live operations/overloads and test all, plus explicit refusals for the rest. Exercise production-write policy in both SDK and agent entry points. | An unsupported operation cannot fall through to sandbox or silently reach Firebase. A refused write performs zero upstream calls. Authorized execution occurs once; no credentials enter events or fixtures. |

## 8. Browser-owned live mode

| ID | CHECK | EXPECT |
| --- | --- | --- |
| 8A — integrated entry | Repeat 0D with the production implementation and supported normal app behavior, including App/Auth ownership, error handling, and declared network/cache controls. | Real upstream execution uses the intended real identity. Observations reach the shared host without transferring credentials. Sandbox controls do not silently remain active in live mode. |
| 8B — lifecycle and packaging | Run packed consumers through cold/warm Vite optimization, import maps, HMR, reload, deletion, and any supported mode change. | One intended SDK instance and recorder lifetime; no duplicate listeners/import recursion; unsupported mode transitions refuse without rerouting existing references. |
| 8C — end-to-end observation | Follow request → original SDK result → encoded observation → Studio → capture → replay/explanation. Interrupt the observation link separately from the Firebase link. | Original SDK result survives recording outages; recording loss is visible; temporal context and uncertainty survive every hop. |

## 9. Hosted live credentials

| ID | CHECK | EXPECT |
| --- | --- | --- |
| 9A — real identity proof | Connect two real credential-backed client identities to an isolated backend with identity/tenant-sensitive rules; rotate/expire credentials. | Backend allows and denies the intended identities; emulated identity or a privileged fallback cannot satisfy this check. Missing/invalid credentials fail before execution. |
| 9B — resource isolation | Change tenant/claims, sign out, reconnect, delete the app, and shut down with listeners and pending requests. | Old sessions dispose their upstream resources; stale callbacks never cross identities; another user's session remains functional. |
| 9C — secrets and controls | Seed distinguishable test credentials, exercise ordinary and privileged clients, then inspect wire/capture/state/diagnostic artifacts and resume attempts. | Unauthorized control and session access fails. Credentials are absent from artifacts and unrelated client traffic. Secret-scanner tests detect deliberate positive fixtures; detection alone is not proof against every possible secret representation. |

The real-credential proof can start early. Hosted live support cannot ship until all its integration prerequisites and gates pass.

## Section joins and release

At each section join, run its complete local gate set and the tests of composed child modules against one candidate artifact. Re-run affected prerequisite gates after changes. Independent codec tests need not rerun for a wording-only edit; a shared wire or lifecycle change invalidates every consuming topology's relevant integration evidence. Without a trustworthy impact map, use the broader suite.

At release, all gates for the advertised feature set plus these checks must pass:

- Required existing CI checks, including applicable conformance coupling and generated-evidence checks. Registry additions/removals require the conformance total-count test. Rules evaluator edits must preserve RuleError absorption behavior.
- Packed artifacts installed outside the workspace under supported package managers/runtimes; smoke the same artifact that is promoted. Source-import success cannot substitute.
- Real browser interruption/soak tests and the full declared support matrix. Do not reuse a developer's already-running server as evidence for the candidate build.
- Every premortem failure is mapped to an executed scenario, an explicit tested unsupported case, or a separately reviewed unresolved risk that blocks the relevant release claim.
- No unhandled rejections, leaked processes/resources, secret-bearing diagnostics, missing required tests, or unexplained flaky passes.

## Existing command inventory

Commands below exist in this repo; they are ingredients, not evidence that the new gates exist. Run from the repository root unless a command says otherwise. They were inspected, not executed as part of writing this specification.

```sh
bun install --frozen-lockfile
bash scripts/build.sh --packages-only
bun run --cwd packages/pyric typecheck
bun run --cwd packages/cli typecheck
bun test packages/cli/test/serve/worker
bun test packages/cli/test/bridge/worker-relay.test.ts packages/cli/test/bridge/remote-session-isolation.test.ts packages/cli/test/bridge/remote-session-stress.test.ts
bun test packages/pyric/test/firestore/internal/value-codec.test.ts packages/cli/test/serve/worker/write-rehydration.test.ts
bun run --cwd packages/cli test:app-conformance
bun run test:soak
bun test packages/conformance/test/src/conformance-model.test.ts
bun run test:packaging
bash scripts/install-matrix.sh npm
bash scripts/install-matrix.sh pnpm
bash scripts/install-matrix.sh bun
```

Build and browser prerequisites apply; reuse a proven build only when its inputs match. The install matrix requires a package-manager argument. The existing Playwright general config permits `reuseExistingServer`; isolated candidate verification must disable that reuse or prove exact server identity. Scenario collection must be checked independently: a command can select several files and still pass after one expected file disappears. The original assessment's missing `fake-indexeddb` means its host tests never supplied baseline evidence.

The scoped U3 checker, initial configuration declarations, browser fixtures and candidate evidence records now exist; their passing scope is recorded in the ledger. Complete gate-dependency verification, runtime bindings for the full support matrix, remaining interruption schedules, resource accounting, enforced retention/latency policies and feature-specific artifact tests remain required. An implemented checker or partial fixture does not close those gates.
