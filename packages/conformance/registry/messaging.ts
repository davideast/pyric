import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

/**
 * Messaging compatibility registry — the first surface authored under
 * Conformance Driven Development (CDD; see `docs/conformance/cdd.md`).
 *
 * ROW UNIVERSE. Every row below is signed off by
 * `packages/conformance/docs/messaging/surface-inventory.md` (wayfinder #44), the v1
 * shape universe enumerated from the installed `firebase@12.13.0`
 * (`@firebase/messaging@0.12.26`, client + service-worker planes) and
 * `firebase-admin@13.10.0` (send plane) typings. Instance-method and
 * option-field completeness closes later with the tier-2 assignability census
 * (resolved decision #5); rows here are authored at export / method / named-type
 * granularity, not one row per option field.
 *
 * TWO SURFACES, ONE DOC. Client + service-worker rows carry surface
 * `'messaging'`; admin send-plane rows carry surface `'messaging-admin'`. Both
 * share this one registry file and one generated `COMPAT.md`, on the
 * `rtdb` / `rtdb-modular` precedent (resolved decision #4). Per-surface
 * conformance-suite paths live on the descriptors in `index.ts`.
 *
 * BORN UNVERIFIED, FLIPPED ON REVIEW. Every row was authored
 * `status: 'unverified'`, `automation: 'unverified'` before the mirrors
 * existed. A row flips to `conforms` (via the seed's `flipped` tier) only when
 * its assertion set in the surface's conformance suite passes unweakened, and
 * both suites run un-gated in their packages' blocking test path. Rows that
 * replay cited `messaging-*` observation values are `oracle-backed`; export,
 * shape, and module-boundary witnesses are `unit-backed` and KEEP their climb
 * risk (`unobserved` / `cited-not-replayed`) — flipping proves the assertion
 * set passes, not that production behavior was observed. A future row added
 * without `flipped` is born unverified and carries a riskReason until its
 * assertion set lands and passes.
 */

type SurfacePlane = 'messaging' | 'messaging-admin';

interface RowSeed {
  surface: SurfacePlane;
  ref: number;
  section: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence: string;
  /** Committed `messaging-*` observations that vouch for `behavior`. */
  observations?: string[];
  /** Additional blocking witnesses outside the in-process surface suite. */
  tests?: string[];
  notes?: string;
  /**
   * CDD flip (Step 4): set at review time when the row's assertion set in the
   * conformance suite passes unweakened. The builder then emits
   * status 'conforms' with this automation tier and wires the surface's
   * suite into conformanceTests. Absent = still climbing (born unverified).
   */
  flipped?: 'oracle-backed' | 'unit-backed';
}

const SUITE: Record<SurfacePlane, string> = {
  messaging: 'packages/pyric/test/messaging/oracle-conformance.test.ts',
  'messaging-admin': 'packages/pyric-admin/test/messaging/oracle-conformance.test.ts',
};

const UNOBSERVED_REASON =
  'Behavior stated from upstream typings/JSDoc only (firebase 12.13.0 / firebase-admin 13.10.0); no committed observation yet — a probe candidate before implementation.';
const CITED_NOT_REPLAYED_REASON =
  'Production observed and cited (see evidence), but not yet replayed offline against a sandbox; the citation does not lock the claim until the conformance suite replays it.';

const buildRow = defineRows({ surface: 'messaging' });

function row(seed: RowSeed): CompatibilityRow {
  const { ref, observations = [], tests = [], flipped, ...rest } = seed;
  const observed = observations.length > 0;
  // Climb risk names the gap between what the row claims and what backs it:
  // 'cited-not-replayed' (score 1) when a committed observation vouches for
  // the behavior but the suite does not replay it, 'unobserved' (score 2)
  // when the behavior is stated from upstream typings/JSDoc alone.
  const climbRisk = {
    risk: [observed ? 'cited-not-replayed' : 'unobserved'],
    riskScore: observed ? 1 : 2,
    riskReasons: [observed ? CITED_NOT_REPLAYED_REASON : UNOBSERVED_REASON],
  };
  // A flip to 'oracle-backed' discharges the climb risk: the cited
  // observations are replayed offline by the blocking conformance suite, so
  // neither reason describes the row any more and the builder's zero-risk
  // defaults are accurate. A flip to 'unit-backed' does NOT discharge it —
  // the assertion set passes, but the behavior itself is still unobserved
  // (or cited without replay), so the row keeps its climb risk. That
  // residual risk is what the audit's evidence-tier worklist ratchets
  // (see packages/conformance/src/ledger.ts, evidenceTierGapRows).
  const climb = flipped
    ? {
        status: 'conforms' as const,
        automation: flipped,
        conformanceTests: [SUITE[seed.surface], ...tests],
        ...(flipped === 'unit-backed' ? climbRisk : {}),
      }
    : {
        status: 'unverified' as const,
        automation: 'unverified' as const,
        ...climbRisk,
      };
  return buildRow({ ...rest, rowRef: String(ref), oracleObservations: observations, ...climb });
}

/**
 * BEHAVIOR-CLASS ROWS. The census (`surface-inventory.md`) enumerates the
 * shape universe — exports, methods, and option shapes. It does not enumerate
 * the runtime behavior classes that span those shapes: send quota / throttling,
 * send retry / backoff, offline store-and-forward delivery, multi-device and
 * multi-tab delivery interactions, and token lifecycle over time. Those classes
 * are authored here so the map covers the territory ("zero unknown gaps" at
 * graduation means every hard class is a classified row, not an unasked
 * question; see the ticket enumeration in `surface-inventory.md`).
 *
 * Every behavior-class row is born at its honest evidence tier and NEVER at
 * `conforms`:
 *   - `unverified` (the default) where a rig could feasibly observe production
 *     but no capture has been committed yet. Its `behavior` is written from
 *     upstream documentation and marked as such in `evidence` (CDD Step 2);
 *     the `evidence`/`notes` name a candidate capture probe that feeds the
 *     scheduled re-capture lane's backlog (#444).
 *   - `unsupported` (via `unsupportedReason`) where the sandbox will never model
 *     the behavior — the written reason becomes the row's `exceptionReason`.
 *
 * Neither tier is a conforms claim, so neither enters the audit's high-risk or
 * evidence-tier worklists (both are `isConforming`-only); no baseline change is
 * required. Each row still carries non-empty `riskReasons` naming what is
 * unevidenced.
 */
interface BehaviorRowSeed {
  surface: SurfacePlane;
  ref: number;
  section: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence: string;
  /** Names what is unevidenced; required non-empty on every behavior-class row. */
  riskReasons: string[];
  notes?: string;
  /**
   * Set for a class the sandbox will never model. Becomes the row's
   * `exceptionReason` and flips it from born-unverified to `unsupported`.
   */
  unsupportedReason?: string;
}

function behaviorRow(seed: BehaviorRowSeed): CompatibilityRow {
  const { ref, surface, riskReasons, unsupportedReason, ...rest } = seed;
  const base = { ...rest, surface, rowRef: String(ref), riskReasons };
  if (unsupportedReason) {
    return buildRow({
      ...base,
      status: 'unsupported',
      automation: 'unsupported',
      exceptionReason: unsupportedReason,
      risk: ['unsupported'],
      riskScore: 0,
    });
  }
  return buildRow({
    ...base,
    status: 'unverified',
    automation: 'unverified',
    risk: ['unobserved'],
    riskScore: 2,
  });
}

// ─── firebase/messaging (client) — surface 'messaging' ───────────────────────
const CLIENT = '`firebase/messaging` (client)';
const clientRows: CompatibilityRow[] = [
  row({
    surface: 'messaging',
    ref: 1,
    featureKeys: ["Messaging"],
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'getMessaging(app?): Messaging',
    behavior:
      'Returns the FCM `Messaging` instance associated with the given (or default) `FirebaseApp`. Bound to the client component registered under the name `messaging`.',
    evidence:
      'Upstream typings/JSDoc (firebase 12.13.0, `@firebase/messaging` 0.12.26); in-process mirror suite plus canonical-import SharedWorker replay `messaging-app-boundary.pw.ts`.',
    tests: ['packages/cli/test/e2e/messaging-app-boundary.pw.ts'],
  }),
  row({
    surface: 'messaging',
    ref: 2,
    featureKeys: ["getToken"],
    flipped: 'oracle-backed',
    section: CLIENT,
    api: 'getToken(messaging, options?): Promise<string>',
    behavior:
      'Subscribes the instance to push and resolves with an FCM registration token; requests notification permission if not already granted and rejects if denied. Production tokens are colon-separated, URL-safe, ~142 chars, with the suffix after the colon beginning `APA91b`, and are stable across repeated `getToken` calls on the same service-worker registration (no per-call rotation).',
    evidence:
      'oracle: `messaging-web-token-shape.json` (minted, length 142, colon-separated, suffix starts `APA91b`, URL-safe) + `messaging-web-token-stability.json` (second `getToken` on the same registration returns the same token). Replayed by the conformance suite.',
    observations: ['messaging-web-token-shape', 'messaging-web-token-stability'],
  }),
  row({
    surface: 'messaging',
    ref: 3,
    featureKeys: ["deleteToken"],
    flipped: 'oracle-backed',
    section: CLIENT,
    api: 'deleteToken(messaging): Promise<boolean>',
    behavior:
      'Deletes the registration token and unsubscribes the instance from its push subscription; resolves truthy. After deletion no message reaches the client on either route, and a server send to the now-dead token eventually surfaces the UNREGISTERED / 404-class error on the send plane (propagation is asynchronous — the first send after delete may still be accepted while delivery has already stopped).',
    evidence:
      'oracle: `messaging-web-deletetoken-unregistered.json` (deleteToken resolved truthy; no delivery to client; send plane eventually UNREGISTERED). Replayed by the conformance suite.',
    observations: ['messaging-web-deletetoken-unregistered'],
  }),
  row({
    surface: 'messaging',
    ref: 4,
    featureKeys: ["onMessage"],
    flipped: 'oracle-backed',
    section: CLIENT,
    api: 'onMessage(messaging, nextOrObserver): Unsubscribe',
    behavior:
      'Dispatched with the push payload when a message arrives while a window client is visible; the returned function stops listening. Routing keys on page VISIBILITY, not focus: a `visibilityState: "visible"` page receives `onMessage` even when unfocused, and when no window client is visible the message routes to the service-worker `onBackgroundMessage` instead.',
    evidence:
      'oracle: `messaging-web-onmessage-foreground.json` (focused page → onMessage) + `messaging-web-visibility-routing.json` (visible → onMessage, no visible client → onBackgroundMessage). Replayed by the conformance suite.',
    observations: ['messaging-web-onmessage-foreground', 'messaging-web-visibility-routing'],
  }),
  row({
    surface: 'messaging',
    ref: 5,
    featureKeys: ["isSupported"],
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'isSupported(): Promise<boolean>',
    behavior:
      'Resolves whether every API required by FCM exists in the current browser window context (bound to `isWindowSupported`).',
    evidence: 'Upstream typings/JSDoc (`@firebase/messaging` 0.12.26); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 6,
    featureKeys: ["Messaging"],
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'interface Messaging { app }',
    behavior: 'Public interface of the FCM client SDK; exposes the bound `FirebaseApp` as `app`.',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 7,
    featureKeys: ["getToken"],
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'interface GetTokenOptions { vapidKey?; serviceWorkerRegistration? }',
    behavior:
      'Options for `getToken`: an optional `vapidKey` (Web Push certificate public key) and an optional `serviceWorkerRegistration`.',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 8,
    featureKeys: ["onMessage"],
    flipped: 'oracle-backed',
    section: CLIENT,
    api: 'interface MessagePayload { notification?; data?; fcmOptions?; from; collapseKey; messageId }',
    behavior:
      'Received message envelope delivered to `onMessage` / `onBackgroundMessage`. Production deliveries carry top-level keys `data`, `from`, `messageId`, and `notification`; `from` equals the project messaging sender id and `messageId` is present. (`from`, `collapseKey`, `messageId` are typed as required.)',
    evidence:
      'oracle: `messaging-web-onmessage-foreground.json` + `messaging-web-onbackgroundmessage.json` (top-level keys data/from/messageId/notification; from = sender id; messageId present). Replayed by the conformance suite.',
    observations: ['messaging-web-onmessage-foreground', 'messaging-web-onbackgroundmessage'],
  }),
  row({
    surface: 'messaging',
    ref: 9,
    featureKeys: ["MessagePayload"],
    flipped: 'oracle-backed',
    section: CLIENT,
    api: 'interface NotificationPayload { title?; body?; image?; icon? }',
    behavior:
      'Display-notification block inside a `MessagePayload`. Production foreground deliveries carry a `notification` object whose keys include `title` and `body`.',
    evidence:
      'oracle: `messaging-web-onmessage-foreground.json` (notificationKeys body, title). Replayed by the conformance suite.',
    observations: ['messaging-web-onmessage-foreground'],
  }),
  row({
    surface: 'messaging',
    ref: 10,
    featureKeys: ["MessagePayload"],
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'interface FcmOptions { link?; analyticsLabel? }',
    behavior: 'WebpushFcmOptions-style options carried on a client `MessagePayload` (`link`, `analyticsLabel`).',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 11,
    featureKeys: ["onMessage"],
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'NextFn, Observer, Unsubscribe (re-exported from @firebase/util)',
    behavior:
      'The callback, observer, and teardown types consumed by `onMessage` / `onBackgroundMessage` are re-exported from `@firebase/util`.',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 re-exports); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 12,
    featureKeys: ["ErrorCode"],
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'const enum ErrorCode (client)',
    behavior:
      'Client failures surface as thrown `FirebaseError`s carrying one of the 18 documented `ErrorCode` values (`missing-app-config-values`, `only-available-in-window`, `only-available-in-sw`, `permission-default`, `permission-blocked`, `unsupported-browser`, `indexed-db-unsupported`, `failed-service-worker-registration`, `token-subscribe-failed`, `token-subscribe-no-token`, `token-unsubscribe-failed`, `token-update-failed`, `token-update-no-token`, `invalid-bg-handler`, `use-sw-after-get-token`, `invalid-sw-registration`, `use-vapid-key-after-get-token`, `invalid-vapid-key`). The enum itself is `@internal`, not a public export.',
    evidence:
      'Upstream typings (`@firebase/messaging` 0.12.26 `src/util/errors`); no client-error observation among the committed set.',
  }),
];

// ─── firebase/messaging/sw (service worker) — surface 'messaging' ─────────────
const SW = '`firebase/messaging/sw` (service worker)';
const swRows: CompatibilityRow[] = [
  row({
    surface: 'messaging',
    ref: 13,
    featureKeys: ["getMessaging","Messaging"],
    flipped: 'unit-backed',
    section: SW,
    api: 'getMessaging(app?): Messaging (sw)',
    behavior:
      'Returns the FCM instance within a service-worker context (bound to `getMessagingInSw`); registers under the component name `messaging-sw`.',
    evidence:
      'Upstream typings (`@firebase/messaging` 0.12.26 `sw/index-public`) plus real module-ServiceWorker served-entry replay `messaging-app-boundary.pw.ts`.',
    tests: ['packages/cli/test/e2e/messaging-app-boundary.pw.ts'],
    notes:
      'The static-server witness imports the generated `/__pyric/sdk/*.js` entry URLs because native module workers do not inherit the page import map. Application source may use `firebase/messaging/sw` through the Vite/register bundler alias, just as production Firebase package imports require a build step.',
  }),
  row({
    surface: 'messaging',
    ref: 14,
    featureKeys: ["onBackgroundMessage"],
    flipped: 'oracle-backed',
    section: SW,
    api: 'onBackgroundMessage(messaging, nextOrObserver): Unsubscribe',
    behavior:
      'Called when a message arrives while the app has no visible window client. Production routes background deliveries here rather than to `onMessage`; the delivered payload carries `data` / `from` / `messageId` and, for notification messages, a `notification` block. A DATA-ONLY message still fires `onBackgroundMessage` with no `notification` key, and a registered handler suppresses the SDK auto-display.',
    evidence:
      'oracle: `messaging-web-onbackgroundmessage.json` (no visible client → onBackgroundMessage) + `messaging-web-visibility-routing.json` + `messaging-web-data-only-background.json` (data-only fires, no notification key). Replayed by the conformance suite and by a real module Service Worker connected to the canonical SharedWorker broker in `messaging-app-boundary.pw.ts`.',
    observations: [
      'messaging-web-onbackgroundmessage',
      'messaging-web-visibility-routing',
      'messaging-web-data-only-background',
    ],
    tests: ['packages/cli/test/e2e/messaging-app-boundary.pw.ts'],
  }),
  row({
    surface: 'messaging',
    ref: 15,
    featureKeys: ["experimentalSetDeliveryMetricsExportedToBigQueryEnabled"],
    flipped: 'unit-backed',
    section: SW,
    api: 'experimentalSetDeliveryMetricsExportedToBigQueryEnabled(messaging, enable): void',
    behavior: 'Enables or disables delivery-metrics export to BigQuery at runtime; default off.',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `sw/index-public`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 16,
    featureKeys: ["isSupported"],
    flipped: 'unit-backed',
    section: SW,
    api: 'isSupported(): Promise<boolean> (sw)',
    behavior:
      'Resolves whether every API required by FCM exists within the service-worker context (bound to `isSwSupported`).',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `sw/index-public`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 17,
    featureKeys: ["getMessaging","onBackgroundMessage","experimentalSetDeliveryMetricsExportedToBigQueryEnabled","isSupported","Messaging"],
    flipped: 'unit-backed',
    section: SW,
    api: 'firebase/messaging/sw module boundary + shared type parity',
    behavior:
      'The sw entry exports `onBackgroundMessage`, `getMessaging`, `experimentalSetDeliveryMetricsExportedToBigQueryEnabled`, and `isSupported`, but NOT `getToken` / `deleteToken` / `onMessage`; the client entry exports the latter but NOT `onBackgroundMessage` / the metrics toggle. The two modules register under different component names (`messaging` vs `messaging-sw`) and re-export identical `Messaging` / `GetTokenOptions` / `MessagePayload` / `NotificationPayload` / `FcmOptions` type declarations.',
    evidence:
      'Upstream typings (`@firebase/messaging` 0.12.26 `index.d.ts` / `index.sw.d.ts`) plus Window and real module-ServiceWorker boundary replay `messaging-app-boundary.pw.ts`.',
    tests: ['packages/cli/test/e2e/messaging-app-boundary.pw.ts'],
  }),
];

// ─── Behavior classes over time & across clients — surface 'messaging' ────────
const CLIENT_BEHAVIOR = 'Behavior classes over time & across clients (client receive plane)';
const clientBehaviorRows: CompatibilityRow[] = [
  behaviorRow({
    surface: 'messaging',
    ref: 18,
    featureKeys: ["onMessage", "onBackgroundMessage"],
    section: CLIENT_BEHAVIOR,
    api: 'Multi-tab delivery routing (several window clients, one shared service worker)',
    behavior:
      'When several window clients (browser tabs) of one origin share a single service-worker registration, a foreground delivery reaches every visible tab through `onMessage`, and when no tab is visible the one shared service worker receives the message once through `onBackgroundMessage` (the worker is shared across tabs, not instantiated per tab). A notification click focuses a single existing client rather than opening a duplicate. Stated from the FCM web SDK and the Service Worker client model; no committed observation replays the multi-tab fan-out yet.',
    evidence:
      'Upstream documentation (`@firebase/messaging` 0.12.26 + W3C Service Worker `Clients` model); no observation yet. Candidate probe: open two tabs on one registration and deliver with one tab visible, then with both hidden — assert `onMessage` fires once per visible tab and `onBackgroundMessage` fires exactly once on the shared worker.',
    riskReasons: [
      'Multi-tab fan-out and shared-service-worker routing stated from FCM web SDK and Service Worker documentation only; no committed observation replays it — a probe candidate before implementation.',
    ],
    notes:
      'Candidate capture for the scheduled re-capture lane (#444): a two-tab browser rig sharing one service-worker registration, asserting per-visible-tab `onMessage` and a single shared-worker `onBackgroundMessage`.',
  }),
  behaviorRow({
    surface: 'messaging',
    ref: 19,
    featureKeys: ["getToken", "onMessage"],
    section: CLIENT_BEHAVIOR,
    api: 'Multi-device delivery (one app instance holding several tokens; per-token fan-out)',
    behavior:
      'A single user or app can hold several registration tokens at once — one per browser, profile, or device. A token-targeted send reaches exactly one token; a topic, condition, or multicast send fans out independently to every subscribed token, with no server-side de-duplication across a user’s devices, so each device receives its own copy. Stated from the FCM targeting model; no committed observation replays cross-device fan-out yet.',
    evidence:
      'Upstream documentation (FCM targeting model); no observation yet. Candidate probe: mint two distinct tokens, subscribe both to one topic, send once, and assert each token receives the message independently.',
    riskReasons: [
      'Per-token multi-device fan-out and the absence of cross-device de-duplication stated from FCM documentation only; no committed observation — a probe candidate before implementation.',
    ],
    notes:
      'Candidate capture for the re-capture lane (#444): two tokens subscribed to one topic, a single send, asserting independent per-token delivery.',
  }),
  behaviorRow({
    surface: 'messaging',
    ref: 20,
    featureKeys: ["getToken", "deleteToken"],
    section: CLIENT_BEHAVIOR,
    api: 'Registration-token rotation and refresh over the app lifecycle',
    behavior:
      'A registration token is stable within a session (row messaging#2 pins that repeated `getToken` calls on one service-worker registration return the same token) but is not permanent across the app lifecycle: the SDK rotates it on events such as app reinstall, SDK upgrade, a restored backup, or a notification-permission change, and Google may retire a token server-side. The modular web SDK has no token-refresh callback, so an app observes a new token only by calling `getToken` again; a rotated-away old token eventually stops delivering and the send plane reports the dead token (the UNREGISTERED path pinned by messaging#3). This lifecycle rotation is deliberately outside the within-session stability observation. Stated from FCM token-management documentation; no committed observation replays rotation across lifecycle events yet.',
    evidence:
      'Upstream documentation (FCM token-management guidance); the committed `messaging-web-token-stability` observation covers only within-session stability, not lifecycle rotation. Candidate probe (long-horizon): force a service-worker unregister/re-register or an app-instance reset, re-mint via `getToken`, and record whether the token changed and whether the prior token then reports UNREGISTERED on send.',
    riskReasons: [
      'Token rotation/refresh across lifecycle events stated from FCM documentation only; the committed stability observation covers within-session stability, not rotation over time — a probe candidate for the scheduled re-capture lane (#444).',
    ],
    notes:
      'Candidate capture for the re-capture lane (#444), long-horizon: re-mint after a forced service-worker re-register / app reset and diff the token; assert the old token reports UNREGISTERED on the send plane.',
  }),
  behaviorRow({
    surface: 'messaging',
    ref: 21,
    featureKeys: ["getToken"],
    section: CLIENT_BEHAVIOR,
    api: 'Registration-token inactivity expiry (server-side staleness window)',
    behavior:
      'FCM treats a registration token that has gone unused for an extended period (Google documents roughly 270 days of app-instance inactivity) as stale and drops it from delivery targeting, independent of any explicit `deleteToken`. The expiry clock is Google server-side inactivity accounting, and the recommended mitigation is periodic token refresh. Stated from FCM best-practices documentation; the sandbox has no server-side inactivity clock to model.',
    evidence:
      'Upstream documentation (FCM registration-token best practices); no observation. This time-based server-side behavior is out of sandbox scope (see the row disposition); the explicit-deletion path to a dead token is already tracked by messaging#3.',
    riskReasons: [
      'Server-side inactivity-based token expiry (the ~270-day staleness window) is unevidenced and cannot be modelled by the sandbox; no observation and no feasible long-horizon probe.',
    ],
    unsupportedReason:
      'Time-based server-side inactivity expiry (the ~270-day staleness window Google enforces) is accounted on Google infrastructure over wall-clock months; the sandbox broker has no inactivity clock and will never model it, and aging a real token for months to capture the transition is neither a feasible nor a repeatable probe. The explicit-deletion path to a dead token is tracked by messaging#3.',
  }),
];

// ─── firebase-admin/messaging (send plane) — surface 'messaging-admin' ────────
const ADMIN_ENTRY = '`firebase-admin/messaging` — entry + `Messaging` class';
const adminEntryRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 1,
    featureKeys: ["Messaging"],
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'getMessaging(app?): Messaging',
    behavior: 'Returns the `Messaging` service for the default or given admin `App`.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `lib/messaging/index`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 2,
    featureKeys: ["getMessaging","messaging"],
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'messaging(app?): messaging.Messaging',
    behavior:
      'Namespaced / legacy accessor equivalent of `getMessaging`, exposed by the compat entry alongside the `namespace messaging` type aliases.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-namespace`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 3,
    featureKeys: ["Messaging"],
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.get app(): App',
    behavior: 'The admin `App` this `Messaging` instance is bound to.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 4,
    featureKeys: ["Messaging","send"],
    flipped: 'oracle-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.send(message, dryRun?): Promise<string>',
    behavior:
      'Sends one message via FCM v1 and resolves with the resource name `projects/<projectId>/messages/<numeric id>`. `dryRun=true` returns the SAME shape (fake id), so callers cannot distinguish validation from acceptance by shape. Topic, condition, token, notification-only, data-only, and webpush-config sends are all accepted. Malformed sends fail server-side validation with HTTP 4xx `google.rpc` error envelopes carrying both a `google.rpc.BadRequest` (fieldViolations) and a `google.firebase.fcm.v1.FcmError` (errorCode); detail ordering is not contractual. The documented data-payload cap is 4096 bytes.',
    evidence:
      'oracle: 10 send-plane observations — accept paths `messaging-send-topic-accepted`, `messaging-send-condition-accepted`, `messaging-send-notification-only-vs-data-only-accepted`, `messaging-send-webpush-config-accepted`; error envelopes `messaging-send-no-target-error-envelope`, `messaging-send-invalid-token-error-envelope`, `messaging-send-invalid-condition-error-envelope`, `messaging-send-invalid-topic-name-error-envelope`, `messaging-send-oversized-payload-error-envelope`, `messaging-send-webpush-invalid-ttl-error-envelope`. Replayed by the conformance suite.',
    observations: [
      'messaging-send-topic-accepted',
      'messaging-send-condition-accepted',
      'messaging-send-notification-only-vs-data-only-accepted',
      'messaging-send-webpush-config-accepted',
      'messaging-send-no-target-error-envelope',
      'messaging-send-invalid-token-error-envelope',
      'messaging-send-invalid-condition-error-envelope',
      'messaging-send-invalid-topic-name-error-envelope',
      'messaging-send-oversized-payload-error-envelope',
      'messaging-send-webpush-invalid-ttl-error-envelope',
    ],
  }),
  row({
    surface: 'messaging-admin',
    ref: 5,
    featureKeys: ["Messaging","sendEach"],
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.sendEach(messages, dryRun?): Promise<BatchResponse>',
    behavior:
      'Sends an array of up to 500 messages, one RPC per message; resolves a `BatchResponse` whose `responses` are ordered to match the input. Total failure is signalled by a throw or an all-failure `BatchResponse`.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 6,
    featureKeys: ["sendEach"],
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.sendEachForMulticast(message, dryRun?): Promise<BatchResponse>',
    behavior: 'Fans a `MulticastMessage` (up to 500 tokens) out through `sendEach`.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 7,
    featureKeys: ["Messaging","subscribeToTopic"],
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.subscribeToTopic(tokenOrTokens, topic): Promise<MessagingTopicManagementResponse>',
    behavior: 'Subscribes one or many registration tokens to a topic; resolves a `MessagingTopicManagementResponse`.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 8,
    featureKeys: ["Messaging","unsubscribeFromTopic"],
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.unsubscribeFromTopic(tokenOrTokens, topic): Promise<MessagingTopicManagementResponse>',
    behavior: 'Unsubscribes one or many registration tokens from a topic; resolves a `MessagingTopicManagementResponse`.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 9,
    featureKeys: ["sendEach","sendEachForMulticast"],
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.enableLegacyHttpTransport(): void',
    behavior: 'Forces HTTP/1.1 transport for `sendEach` / `sendEachForMulticast`; deprecated.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`, `@deprecated`); no observation yet.',
  }),
];

const ADMIN_TARGETS = '`Message` union + targets';
const adminTargetRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 10,
    featureKeys: ["Message","TokenMessage","TopicMessage","ConditionMessage"],
    flipped: 'unit-backed',
    section: ADMIN_TARGETS,
    api: 'type Message = TokenMessage | TopicMessage | ConditionMessage',
    behavior: 'A send payload carrying exactly one of token, topic, or condition.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 11,
    featureKeys: ["BaseMessage"],
    flipped: 'oracle-backed',
    section: ADMIN_TARGETS,
    api: 'interface BaseMessage { data?; notification?; android?; webpush?; apns?; fcmOptions? }',
    behavior:
      'Common message fields shared by every target variant. Production accepts a message carrying ONLY a `notification` block and, separately, ONLY a `data` block — neither is individually required.',
    evidence:
      'oracle: `messaging-send-notification-only-vs-data-only-accepted.json` (both accepted). Replayed by the conformance suite.',
    observations: ['messaging-send-notification-only-vs-data-only-accepted'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 12,
    featureKeys: ["BaseMessage","TokenMessage"],
    flipped: 'oracle-backed',
    section: ADMIN_TARGETS,
    api: 'interface TokenMessage extends BaseMessage { token: string }',
    behavior:
      'A device-token target. A syntactically invalid token is rejected with HTTP 400 INVALID_ARGUMENT whose fieldViolations name `message.token`.',
    evidence:
      'oracle: `messaging-send-invalid-token-error-envelope.json` (fieldViolations names message.token). Replayed by the conformance suite.',
    observations: ['messaging-send-invalid-token-error-envelope'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 13,
    featureKeys: ["BaseMessage","TopicMessage"],
    flipped: 'oracle-backed',
    section: ADMIN_TARGETS,
    api: 'interface TopicMessage extends BaseMessage { topic: string }',
    behavior:
      'A topic target. A well-formed topic send is accepted and returns the standard resource name (no subscribers required); a topic name containing characters outside the documented `[a-zA-Z0-9-_.~%]` set is rejected with an INVALID_ARGUMENT error envelope.',
    evidence:
      'oracle: `messaging-send-topic-accepted.json` (accepted) + `messaging-send-invalid-topic-name-error-envelope.json` (bad name rejected). Replayed by the conformance suite.',
    observations: ['messaging-send-topic-accepted', 'messaging-send-invalid-topic-name-error-envelope'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 14,
    featureKeys: ["BaseMessage","ConditionMessage"],
    flipped: 'oracle-backed',
    section: ADMIN_TARGETS,
    api: 'interface ConditionMessage extends BaseMessage { condition: string }',
    behavior:
      'A condition target. A well-formed condition of the form `"\'a\' in topics && \'b\' in topics"` is accepted with the standard resource-name shape (no subscribers required); a malformed condition (dangling operator) is rejected with an error envelope.',
    evidence:
      'oracle: `messaging-send-condition-accepted.json` (accepted) + `messaging-send-invalid-condition-error-envelope.json` (malformed rejected). Replayed by the conformance suite.',
    observations: ['messaging-send-condition-accepted', 'messaging-send-invalid-condition-error-envelope'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 15,
    featureKeys: ["BaseMessage"],
    flipped: 'unit-backed',
    section: ADMIN_TARGETS,
    api: 'interface MulticastMessage extends BaseMessage { tokens: string[] }',
    behavior: 'A multicast target of up to 500 tokens, fanned out by `sendEachForMulticast`.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
];

const ADMIN_CONFIG = 'Payload / config option shapes';
const adminConfigRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 16,
    featureKeys: ["Notification"],
    flipped: 'oracle-backed',
    section: ADMIN_CONFIG,
    api: 'interface Notification { title?; body?; imageUrl? }',
    behavior:
      'Top-level, platform-independent notification block. Production accepts a notification-only message (no data block).',
    evidence:
      'oracle: `messaging-send-notification-only-vs-data-only-accepted.json`. Replayed by the conformance suite.',
    observations: ['messaging-send-notification-only-vs-data-only-accepted'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 17,
    featureKeys: ["FcmOptions"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface FcmOptions { analyticsLabel? }',
    behavior: 'Platform-independent FCM options (`analyticsLabel`).',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 18,
    featureKeys: ["WebpushConfig"],
    flipped: 'oracle-backed',
    section: ADMIN_CONFIG,
    api: 'interface WebpushConfig { headers?; data?; notification?; fcmOptions? }',
    behavior:
      'Webpush overrides. Production accepts a webpush config carrying `headers.TTL` and `fcmOptions.link`; a non-numeric `headers.TTL` is rejected with an error envelope.',
    evidence:
      'oracle: `messaging-send-webpush-config-accepted.json` (accepted) + `messaging-send-webpush-invalid-ttl-error-envelope.json` (bad TTL rejected). Replayed by the conformance suite.',
    observations: ['messaging-send-webpush-config-accepted', 'messaging-send-webpush-invalid-ttl-error-envelope'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 19,
    featureKeys: ["WebpushFcmOptions"],
    flipped: 'oracle-backed',
    section: ADMIN_CONFIG,
    api: 'interface WebpushFcmOptions { link? }',
    behavior: 'Webpush FCM options (`link`, HTTPS required). Production accepts `fcmOptions.link` on a webpush send.',
    evidence:
      'oracle: `messaging-send-webpush-config-accepted.json` (link accepted). Replayed by the conformance suite.',
    observations: ['messaging-send-webpush-config-accepted'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 20,
    featureKeys: ["Notification"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface WebpushNotification { title?; actions?; badge?; body?; dir?; icon?; image?; renotify?; requireInteraction?; silent?; tag?; vibrate?; [key] }',
    behavior: 'Web Notification API-shaped options, including an open-ended index signature.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 21,
    featureKeys: ["ApnsConfig"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface ApnsConfig { liveActivityToken?; headers?; payload?; fcmOptions? }',
    behavior: 'APNs overrides.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 22,
    featureKeys: ["ApnsPayload"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface ApnsPayload { aps; [customData] }',
    behavior: 'APNs payload wrapper carrying the required `aps` dictionary plus arbitrary custom keys.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 23,
    featureKeys: ["Aps"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface Aps { alert?; badge?; sound?; contentAvailable?; mutableContent?; category?; threadId?; [customData] }',
    behavior: 'APNs `aps` dictionary; `alert` is a string or an `ApsAlert`, `sound` a string or a `CriticalSound`.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 24,
    featureKeys: ["ApsAlert"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface ApsAlert { title?; subtitle?; body?; locKey?; locArgs?; ...; launchImage? }',
    behavior: 'APNs alert object with title/subtitle/body and localization keys.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 25,
    featureKeys: ["CriticalSound"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface CriticalSound { critical?; name; volume? }',
    behavior: 'APNs critical sound — `name` required; `volume` in the range 0.0–1.0.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 26,
    featureKeys: ["ApnsFcmOptions"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface ApnsFcmOptions { analyticsLabel?; imageUrl? }',
    behavior: 'APNs FCM options (`analyticsLabel`, `imageUrl`).',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 27,
    featureKeys: ["AndroidConfig"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface AndroidConfig { collapseKey?; priority?; ttl?; restrictedPackageName?; data?; notification?; fcmOptions?; ... }',
    behavior: 'Android overrides; `ttl` is in milliseconds and `priority` is `high` | `normal`.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 28,
    featureKeys: ["AndroidNotification"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface AndroidNotification { title?; body?; icon?; color?; sound?; tag?; imageUrl?; channelId?; priority?; visibility?; lightSettings?; ... }',
    behavior: 'Android notification options, including localization keys, LED light settings, and delivery-proxy controls.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 29,
    featureKeys: ["LightSettings"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface LightSettings { color; lightOnDurationMillis; lightOffDurationMillis }',
    behavior: 'Android LED light settings — all three fields required.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 30,
    featureKeys: ["AndroidFcmOptions"],
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface AndroidFcmOptions { analyticsLabel? }',
    behavior: 'Android FCM options (`analyticsLabel`).',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
];

const ADMIN_LEGACY = 'Legacy payload shapes';
const adminLegacyRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 31,
    featureKeys: ["DataMessagePayload"],
    flipped: 'unit-backed',
    section: ADMIN_LEGACY,
    api: 'interface DataMessagePayload { [key]: string }',
    behavior: 'Legacy data payload — up to 4KB; the keys `from` and `google.*` are reserved.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 32,
    featureKeys: ["NotificationMessagePayload"],
    flipped: 'unit-backed',
    section: ADMIN_LEGACY,
    api: 'interface NotificationMessagePayload { tag?; body?; icon?; badge?; color?; sound?; title?; ...; [key] }',
    behavior: 'Legacy notification payload with localization keys, a `clickAction`, and arbitrary string keys.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 33,
    featureKeys: ["MessagingPayload"],
    flipped: 'unit-backed',
    section: ADMIN_LEGACY,
    api: 'interface MessagingPayload { data?; notification? }',
    behavior: 'Legacy combined payload — one or both of `data` / `notification` required.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 34,
    featureKeys: ["MessagingOptions"],
    flipped: 'unit-backed',
    section: ADMIN_LEGACY,
    api: 'interface MessagingOptions { dryRun?; priority?; timeToLive?; collapseKey?; mutableContent?; contentAvailable?; restrictedPackageName?; [key] }',
    behavior:
      'Legacy send options; documented defaults are dryRun false, ttl 2419200s (4 weeks), priority high for notifications / normal for data.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
];

const ADMIN_RESPONSES = 'Response shapes';
const adminResponseRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 35,
    featureKeys: ["MessagingTopicManagementResponse"],
    flipped: 'unit-backed',
    section: ADMIN_RESPONSES,
    api: 'interface MessagingTopicManagementResponse { failureCount; successCount; errors }',
    behavior: 'Topic subscribe / unsubscribe result carrying per-index errors as `FirebaseArrayIndexError[]`.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 36,
    featureKeys: ["SendResponse"],
    flipped: 'unit-backed',
    section: ADMIN_RESPONSES,
    api: 'interface BatchResponse { responses; successCount; failureCount }',
    behavior: 'Batch send result; `responses` is a `SendResponse[]`.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 37,
    featureKeys: ["SendResponse"],
    flipped: 'unit-backed',
    section: ADMIN_RESPONSES,
    api: 'interface SendResponse { success; messageId?; error? }',
    behavior: 'Per-message batch entry — on success `messageId` is set, on failure `error` is set.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
];

const ADMIN_ERRORS = 'Errors';
const adminErrorRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 38,
    featureKeys: ["FirebaseMessagingError"],
    flipped: 'unit-backed',
    section: ADMIN_ERRORS,
    api: 'class FirebaseMessagingError extends PrefixedFirebaseError',
    behavior: 'The exported admin messaging error type.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `lib/messaging/index`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 39,
    featureKeys: ["MessagingClientErrorCode"],
    flipped: 'oracle-backed',
    section: ADMIN_ERRORS,
    api: 'class MessagingClientErrorCode',
    behavior:
      'Exported static `{ code, message }` members (`INVALID_ARGUMENT`, `INVALID_RECIPIENT`, `INVALID_PAYLOAD`, … `UNKNOWN_ERROR`). The wire-level `INVALID_ARGUMENT` FcmError returned by malformed sends maps to `MessagingClientErrorCode.INVALID_ARGUMENT`.',
    evidence:
      'oracle: `messaging-send-no-target-error-envelope.json` + `messaging-send-invalid-token-error-envelope.json` (both carry the INVALID_ARGUMENT FcmError). Replayed by the conformance suite.',
    observations: ['messaging-send-no-target-error-envelope', 'messaging-send-invalid-token-error-envelope'],
  }),
];

const ADMIN_BEHAVIOR = 'Behavior classes — quota, retry, offline delivery (send plane)';
const adminBehaviorRows: CompatibilityRow[] = [
  behaviorRow({
    surface: 'messaging-admin',
    ref: 40,
    featureKeys: ["send", "sendEach"],
    section: ADMIN_BEHAVIOR,
    api: 'FCM send quota and rate-limit throttling',
    behavior:
      'FCM enforces project-level send quotas and per-target rate limits (per-device and per-topic message rates) accounted on Google servers over rolling windows; exceeding them yields quota / rate-limit rejections. The admin error taxonomy names these as `MessagingClientErrorCode.MESSAGE_RATE_EXCEEDED`, `DEVICE_MESSAGE_RATE_EXCEEDED`, and `TOPICS_MESSAGE_RATE_EXCEEDED` (wire `QUOTA_EXCEEDED` / `RESOURCE_EXHAUSTED`, HTTP 429). Stated from FCM quota documentation; the sandbox has no global quota ledger to model.',
    evidence:
      'Upstream documentation (FCM quotas and `MessagingClientErrorCode` rate-limit members, firebase-admin 13.10.0); no observation. This behavior is out of sandbox scope (see the row disposition).',
    riskReasons: [
      'FCM quota / rate-limit throttling and its `MESSAGE_RATE_EXCEEDED` / `DEVICE_MESSAGE_RATE_EXCEEDED` / `TOPICS_MESSAGE_RATE_EXCEEDED` envelopes are unevidenced and unmodellable in the sandbox; no observation and no safe probe.',
    ],
    unsupportedReason:
      'Send quota and rate-limit accounting is enforced on Google infrastructure over rolling per-project and per-target windows; the sandbox broker keeps no global quota ledger and will never model it, and deliberately exhausting production quota to capture the rate-limit envelope is neither a safe nor a repeatable probe.',
  }),
  behaviorRow({
    surface: 'messaging-admin',
    ref: 41,
    featureKeys: ["send", "enableLegacyHttpTransport"],
    section: ADMIN_BEHAVIOR,
    api: 'Send retry and backoff on transient transport failures',
    behavior:
      'The admin SDK retries transient send-transport failures — connection errors and HTTP 5xx / `SERVER_UNAVAILABLE` / `INTERNAL` responses — with backoff before surfacing the error to the caller, so a caller sees a resolved send or a terminal error rather than every intermediate failure. `enableLegacyHttpTransport` switches `sendEach` / `sendEachForMulticast` from HTTP/2 to HTTP/1.1, changing multiplexing and the retry/transport path. Stated from the admin SDK and google-auth transport documentation; no committed observation replays the retry count or backoff schedule yet.',
    evidence:
      'Upstream documentation (firebase-admin 13.10.0 send transport + google-auth retry defaults); no observation yet. Candidate probe: point the send transport at a fault-injecting stub that returns 503 then 200 and record the retry count and backoff intervals before the resolved send.',
    riskReasons: [
      'Send retry/backoff on transient 5xx and connection failures stated from admin SDK / transport documentation only; no committed observation records the retry count or backoff schedule — a probe candidate before implementation.',
    ],
    notes:
      'Candidate capture for the re-capture lane (#444): a fault-injecting stub endpoint returning 503 then 200, asserting the SDK retries with backoff and the caller observes a single resolved send.',
  }),
  behaviorRow({
    surface: 'messaging-admin',
    ref: 42,
    featureKeys: ["send", "AndroidConfig"],
    section: ADMIN_BEHAVIOR,
    api: 'Offline store-and-forward delivery — TTL and collapse-key semantics',
    behavior:
      'When a target device is offline FCM stores the message and delivers it on reconnect, up to its time-to-live (`android.ttl`, APNs expiration, webpush `headers.TTL`; the legacy default is 2419200 seconds / four weeks). A collapse key (`android.collapseKey`, `collapseKey`) marks a message as collapsible so a newer collapsible message replaces an older still-undelivered one, and only the last is delivered on reconnect; a message whose TTL elapses before reconnect is dropped rather than delivered. Stated from FCM message-lifecycle documentation; no committed observation replays store-and-forward, collapse, or TTL expiry yet.',
    evidence:
      'Upstream documentation (FCM message lifecycle: TTL, collapse keys, store-and-forward); no observation yet. Candidate probe: send several collapsible messages to a token whose web client is offline, bring it online within TTL, and assert only the last collapsible message is delivered; separately, let a short-TTL message expire before reconnect and assert it is dropped.',
    riskReasons: [
      'Store-and-forward queuing, collapse-key replacement, and TTL expiry-drop stated from FCM lifecycle documentation only; no committed observation replays offline delivery — a probe candidate before implementation.',
    ],
    notes:
      'Candidate capture for the re-capture lane (#444): an offline-then-reconnect web client asserting collapse-key last-write-wins delivery and TTL expiry drop.',
  }),
];

const INTRO = [
  '# `pyric` messaging compatibility matrix',
  '',
  '## Status legend',
  '',
  '| Status | Meaning |',
  '|---|---|',
  '| ✓ | **Conforming** — sandbox matches prod, locked by a passing probe |',
  '| ⚠ | **Diverged (documented)** — intentional difference with a written reason |',
  '| ✗ | **Bug** — should match prod but doesn\'t; failing probe pins it |',
  '| — | **Not implemented yet** — deliberately or pending |',
  '| ? | **Unverified** — a target with a derived failing test, not a guarantee |',
].join('\n');

const rows: CompatibilityRow[] = [
  ...clientRows,
  ...swRows,
  ...clientBehaviorRows,
  ...adminEntryRows,
  ...adminTargetRows,
  ...adminConfigRows,
  ...adminLegacyRows,
  ...adminResponseRows,
  ...adminErrorRows,
  ...adminBehaviorRows,
];

export const messagingRegistry: CompatibilitySurfaceRegistry = {
  surface: 'messaging',
  label: 'Messaging',
  compatPath: 'packages/pyric/docs/messaging/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO + '\n' },
    { kind: 'table', prefix: `## ${CLIENT}\n`, rows: clientRows },
    { kind: 'table', prefix: `## ${SW}\n`, rows: swRows },
    { kind: 'table', prefix: `## ${CLIENT_BEHAVIOR}\n`, rows: clientBehaviorRows },
    { kind: 'table', prefix: `## ${ADMIN_ENTRY}\n`, rows: adminEntryRows },
    { kind: 'table', prefix: `## ${ADMIN_TARGETS}\n`, rows: adminTargetRows },
    { kind: 'table', prefix: `## ${ADMIN_CONFIG}\n`, rows: adminConfigRows },
    { kind: 'table', prefix: `## ${ADMIN_LEGACY}\n`, rows: adminLegacyRows },
    { kind: 'table', prefix: `## ${ADMIN_RESPONSES}\n`, rows: adminResponseRows },
    { kind: 'table', prefix: `## ${ADMIN_ERRORS}\n`, rows: adminErrorRows },
    { kind: 'table', prefix: `## ${ADMIN_BEHAVIOR}\n`, rows: adminBehaviorRows },
  ],
};

/** All messaging rows in doc order (client + sw + admin). */
export const messagingRows = rows;
