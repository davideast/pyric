# Firebase activity on the page: implementation plan

Status: Phase 0 merged in PR #635. Phase 1 is implemented on `firebase-read-flow`; remaining phases are proposed scope.

## Outcome and boundaries

Make Firebase activity understandable where someone is already using their app: notice a highlight, select the affected region, and see the source and recent activity without opening Studio. Repeated requests should be visible even when they return unchanged data or produce no visible update.

Use one activity model for both subscriptions and one-shot reads. A subscription can deliver repeatedly; a one-shot read settles once. Neither distinction changes how an observed subsequent render is painted. A Promise is an asynchronous completion mechanism; it does not imply database transaction guarantees.

The first release should let someone answer “what ran, how often, and what rendered afterward?” It should not require them to learn five new tools or configure a framework plugin.

## What we can claim

| Evidence | Reliable statement | Limit |
| --- | --- | --- |
| SDK invocation and outcome | This app called this method on this target; it succeeded or failed. | Not a server round trip, billing estimate, or proof of waste. |
| Public callback or successful read completion | This subscription delivered N times; this read completed. | Transport messages and internal observers are not public deliveries. |
| Observed render association | These components rendered after this delivery. | Temporal association is not proof that every rendered value came from this source. |
| No associated region | Activity was observed, but no visual update was associated. | This does not prove the data was unused or the app did not render. |
| Retained association | This still-existing region was last observed after these sources delivered. | Not continuous provenance through caches, state stores, transforms, or later unrelated renders. |

The existing Flow correlation window and React commit observation are useful foundations, not deterministic data lineage. Multiple sources in one commit must remain multiple candidates. Unsupported render instrumentation must show an unavailable/unmapped state rather than fabricated geometry.

## Phase 0 — Treatment selection is trustworthy

**Size: small; prerequisite for demo confidence.**

The chip and Flow Studies already share the treatment controller, catalog, and lazy-loaded modules. The page controls a demonstration; applications consume the same controller through listener mode.

A reproduced defect in `flow-treatments/controller.ts`: while `attach()` awaited configuration discovery, an explicit `select()` could start. When discovery finished, attachment started another selection of the default, invalidating the user's request. This could affect any shared-runtime consumer, not only Flow Studies.

The fix gives an explicit selection precedence over the pending attachment. Existing failure behavior keeps the last working treatment and exposes retry. Keep the committed controller state authoritative for UI selection. A style change must repaint existing marks without incrementing SDK or delivery counts; Flow Studies may separately trigger its documented preview delivery.

Acceptance:

- A selection during delayed configuration wins over the project/default selection, in the controller and a real browser.
- Changing from every built-in to Crisp outline through either selector removes the previous decoration and applies the actual outline CSS.
- A delayed page module cannot overwrite a later chip selection.
- Reload restores the saved choice; a failed custom module preserves working paint and retry; disposal invalidates pending work.

These checks establish a concrete startup failure and ordinary switching coverage. They do not establish that startup timing explains every instance of the user's reported wrong style. If a settled, fully loaded page still reproduces it, capture that exact preceding treatment and host page before broadening the fix.

## Phase 1 — One shared lifecycle, proven with reads

**Size: medium; highest-value first slice.**

Introduce an internal activity record that can represent subscription, operation, and task lifetimes. Place cross-service lifecycle and identity normalization in `packages/pyric/src/sandbox/internal/`, exposed through the existing internal boundary. Keep browser ownership capture, React observation, DOM references, and painting in the CLI runtime.

The record needs app-scoped activity identity, service, method, sanitized target, lifetime kind, start/outcome timestamps, and public delivery identity. Keep logical source identity distinct from an invocation, subscription registration, and worker transport ID. Repeated reads of the same target are separate calls, while their source can be grouped. Scope query identity by its actual query shape, not path alone.

Migrate current Firestore and RTDB listeners through this model first. Then instrument Firestore `getDoc`/`getDocs` and RTDB `get` at their SDK boundaries. Do not turn one-shot reads into fake subscriptions. Completing an operation must leave its delivery eligible for the existing render-correlation window, then expire that pending record normally.

A small service adapter should provide service-specific metadata and lifecycle events. It should not implement counters, record retention, render-window scheduling, or treatment selection. Do not wrap every worker subscription centrally: transport arrival is not necessarily a public callback, and internal Auth/persistence subscriptions must remain excluded.

Acceptance:

- One real example exercises a listener and a one-shot read into the same component through both in-page sandbox and worker bridge.
- Calls, completions, errors, and delivered callbacks are counted once at the correct boundary. Cached successes and equal results still count as activity.
- Preserve callback arguments, `this`, return/throw behavior, unsubscribe behavior, Promise identity where applicable, and observable completion ordering. Test observer exceptions and rejected Promises without introducing extra unhandled rejections.
- Two Firebase app instances cannot collide. Duplicate subscriptions remain separately inspectable.
- A successful read with no associated render still appears in the chip. A read failure never invents a successful delivery or region.
- Detached/finished activities do not leak, but terminal delivery remains eligible for a subsequent observed commit.

**Stop gate:** prove this end-to-end slice and its semantics before adding other services or generalizing beyond the concrete needs of these adapters.

## Phase 2 — Counts, explanation, and a small history

**Size: small to medium after Phase 1.**

Use one compact activity list in the chip, with progressive details on selection. Preserve existing Overview/Flow controls; avoid five additional top-level tabs. Plan any rename from “Listeners” to “Activity” alongside subscription visibility controls so users can still find them.

A region selection shows service, target, method, lifetime (live subscription or completed read), observed request/delivery counts, and recent outcomes. Use “rendered after” for temporal associations. Display all candidate sources for a shared commit instead of arbitrarily choosing one.

Expose exact recent activity frequency with a named time window. Keep request counts, deliveries, and associated commits separate; one delivery may paint several component marks. Do not call these billable reads or automatically label repeated requests “redundant.”

Use a bounded recent-event buffer, initially 100 metadata-only records per page, with explicit truncation text. Group activity without hiding individual invocations. Selecting a past record can highlight surviving observed regions; it does not replay old DOM or reconstruct past app state. Unmapped activity belongs in this same list with “No associated visual update,” not in an intrusive warning.

Acceptance:

- A burst, repeated equal-value reads, and several renders after one delivery remain distinguishable.
- Counts specify their scope and reset/retention behavior; clearing the view has a defined effect independent of active registrations.
- History eviction releases references and clearly indicates older records were discarded.
- In-app selection works by keyboard and pointer, has a clear selection state, and does not navigate to Studio by default.
- Shared column tracks, fixed action sizes, and gap-based spacing survive long paths and narrow viewports.
- Default records exclude payloads, auth tokens, and message contents; sanitize target strings that contain credentials or sensitive query values.

**Stop gate:** a new user can find which call repeated and inspect it from the app without confusing an observed association with proven data ownership.

## Phase 3 — Retain useful associations honestly

**Size: medium; attribution and cleanup are the difficult parts.**

Retain a bounded set of last-observed source associations for still-existing regions. The current painter retains visual marks already; inspect and reuse that lifecycle rather than introducing a second overlay store. Separate historical evidence from the single source currently owning a visible color/label.

Define policies for multiple deliveries in one commit, unrelated later renders, DOM replacement, unmount, navigation, and expired activity. Prefer retaining a qualified historical association or reporting ambiguity over silently replacing it with an asserted source of truth. Use “last observed” in details, with age, rather than an always-authoritative source badge.

Acceptance:

- Multiple candidate sources remain visible for one batched commit.
- Removed/replaced nodes and route changes release associations and overlays.
- Selecting old history never highlights a different element that reused an ID.
- Unrelated subsequent renders do not become invented Firebase deliveries.
- Document scroll, nested scroll, resize, and native-anchor/fallback positioning preserve attachment for every supported treatment surface.

**Stop gate:** if reliable cleanup or understandable ambiguity requires a general provenance engine, ship Phases 1–2 and defer this phase.

## Phase 4 — Add services one adapter at a time

| Service / surface | Relative complexity | Hard part | Ship condition |
| --- | --- | --- | --- |
| Auth state and ID-token observers | Medium | Initial callback, duplicate registrations, user normalization, and excluding internal persistence observers in both runtimes. | Only app-visible callbacks count; sign-in, sign-out, token changes, initial callback, and unsubscribe match SDK behavior. |
| Foreground Messaging | Small to medium | Distinguishing delivery to a foreground page from background execution. | Foreground callbacks can associate with that page's commits; background events remain activity without a DOM claim. |
| Storage upload progress | Medium to high | Task lifecycle, observer registration with immediate notification, pause/resume/cancel, terminal callbacks, and thenable completion. | Per-observer delivery and task progress are not double-counted; terminal events can still precede renders. |
| Functions client results | Medium for callable/request completion | Instrument the frontend result as a one-shot operation with appropriate sanitized target metadata. | A direct client result uses the same completion/render path as reads. |
| Function execution → database write → listener → UI | High; defer | Cross-runtime parent/correlation IDs, trigger retries, and distinguishing temporal sequence from causality. | Only add a causal view after explicit trace propagation exists; current execution events are insufficient. |

Reuse the lifecycle and UI from earlier phases. Service adapters should add no new styling system and normally no new chip controls. Additional one-shot Storage or other SDK reads can follow the operation path after their return semantics are characterized.

## Code map and verification

| Boundary | Starting point |
| --- | --- |
| Existing canonical events | `packages/pyric/src/sandbox/types/events.ts` |
| Existing listener projection and service assumptions | `packages/pyric/src/sandbox/active-listeners.ts` |
| Worker public delivery hooks | `packages/cli/src/serve/worker/client/listener-delivery.ts` |
| Browser lifecycle / correlation / paint | `packages/cli/src/serve/runtime/listener-mode.ts`, `listener-flow-mode.ts`, `listener-flow-painter.ts` |
| Shared selection and lazy loading | `packages/cli/src/serve/runtime/flow-treatments/controller.ts` |
| In-app UI | `packages/cli/src/serve/runtime/chip.ts` |
| Manual demo | `examples/runtime-flow-lab/` |

Each phase needs focused lifecycle tests plus a browser integration test across the real boundary it changes. Flow Studies uses fixture deliveries with real React commits and painting; it is not proof of SDK or worker transport instrumentation. Add real SDK integration coverage separately.

Verify sandbox/worker parity for every SDK surface change. Reuse shared path/auth/error normalization. If new code branches between Node and browser APIs, force both branches in tests. Rules error algebra and conformance registry totals are unchanged by the planned diagnostic work; if implementation touches them, run their required checks rather than assuming they are unrelated.

## Recommended commitment

Commit to Phases 0–2 first. That delivers one-shot read visibility, honest counts, useful inline explanation, unmapped activity, and a bounded history using the existing rendering foundation. Treat Phase 3 as a gated follow-up and Phase 4 as independently shippable adapters. Defer automatic “waste” judgments, complete data provenance, cross-service causal graphs, DOM time travel, and framework-independent exact attribution.


## Phase 1 outcome and verification

Firestore `getDoc`/`getDocs`, RTDB `get`, and existing listeners now report through a shared internal SDK activity journal in both the in-page sandbox and worker bridge. The journal separates app, source, invocation, registration, and transport identity. Query shape participates in source identity; public callbacks and successful reads are counted once, including equal-value results. Worker-host mirror calls are excluded from public SDK activity.

Completed reads remain eligible for the 250 ms render-correlation window. The chip shows pending, completed, failed, active, and closed activity, with an explicit observed-render or unmapped state. Lifecycle and association changes refresh the chip independently of delivery counts. Enabling Flow does not invent an association by replaying an unmapped SDK read's owner region.

Terminal records expire after 30 seconds. More than 100 terminal records trigger oldest-first eviction after the correlation window; active registrations are retained until stopped. Reentrant removal notifications cannot expire a record twice. Removal propagates to runtime marks and visibility state, and disposal removes subscriptions, timers, and DOM references.

The actual SDK example lives in `examples/runtime-flow-lab/sdk-app.ts`, with `sdk-worker.ts` and `sdk-server.mts`. Its in-page and SharedWorker modes exercise three one-shot read surfaces and two subscriptions into the same React component, plus unmapped and denied reads. Run instructions are in the example README. Flow Studies remains a separate fixture-driven treatment demonstration.

Verified checks:

| Boundary | Evidence |
| --- | --- |
| Build and types | `bun run build` builds every package; `bunx --no-install tsc -p examples/runtime-flow-lab/tsconfig.json` passes. |
| Shared lifecycle and SDK semantics | 330 passing tests across `sdk-activity`, `sdk-read-activity`, `sdk-app-activity`, `sdk-listener-activity`, Firestore sandbox-target, RTDB modular, and multi-app listener authorization suites. |
| Worker and runtime | `bun test packages/cli/test/serve/runtime packages/cli/test/serve/worker`: 768 tests pass across 99 files. |
| Actual browser integration | `sdk-flow.pw.ts`: both in-page and actual SharedWorker cases pass, requiring a distinct highlight per read and checking listener updates/closure, unmapped reads, denied reads, treatment switching, and actual timed row/mark expiration. |
| Promise and callback behavior | Enabled/silenced diagnostics preserve observed settlement ordering for document/query/RTDB reads and rejected reads. Throwing diagnostic subscribers produce no extra unhandled rejections. Duplicate and only-once listeners count public callbacks; observer context and app-deletion outcomes are covered. |
| Identity and double-counting | Real Firebase apps share identity across services while remaining separate from other apps. Worker tests verify independent ports, duplicate registrations, transport IDs, repeated sources, exact delivery totals, and absence of host-mirror duplicates. |
| Cleanup and paint | Journal timer/reentrancy regressions, runtime disposal and detached-photo tests, real browser expiration checks, and visual inspection of the SDK example. |

Integration-boundary audit: sandbox/worker parity and shared foundation reuse are exercised directly. Browser tests execute browser timer/worker paths as well as the unit tests' Node/Bun paths. This work changes no rules evaluator algebra, conformance registry rows, or auth enforcement fields.

Limitations remain deliberate: association requires an observed supported render while Flow is watching, and it describes what rendered after delivery rather than proving data ownership. Retention is short-lived diagnostic metadata, not durable history or a billing estimate. The existing supported SDK surface is preserved; Phase 1 does not introduce multi-project runtime support, other service adapters, causal tracing, or richer history controls. Phases 2–4 remain separate work.
