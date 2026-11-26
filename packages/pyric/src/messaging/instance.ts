/**
 * Shared plumbing for the two receive-plane mirror entries
 * (`pyric/messaging` — window client — and `pyric/messaging/sw` — service
 * worker). Both entries bind to the SAME per-sandbox {@link MessagingBroker},
 * mirroring production's one-service-worker-per-origin model: a window
 * `onMessage` handler and a sw `onBackgroundMessage` handler registered
 * against the same sandbox observe the same delivery stream, routed
 * exclusively by client visibility (the captured rule).
 *
 * `getMessaging()` with no app mirrors `firebase/messaging` by resolving the
 * default app registered through `pyric/app`.
 */
import type { FirebaseApp } from '../app/types.js';
import { defaultClientApp, resolveClientApp } from '../sandbox/internal/client-app.js';
import type { Sandbox, SandboxContext } from '../sandbox/index.js';
import { SandboxContextImpl } from '../sandbox/index.js';
import { DEFAULT_CLIENT_ID, getMessagingBroker, MessagingBroker } from './broker/index.js';
import type { DeliveryResult } from './broker/index.js';

/**
 * The FCM `Messaging` instance mirror — exposes the bound app as `app`
 * (upstream `@firebase/messaging` public-types parity).
 */
export interface Messaging {
  readonly app: FirebaseApp;
}

export type MessagingPlane = 'window' | 'sw';

export type FidObserverLike =
  | ((fid: string) => void)
  | {
      next: (fid: string) => void;
      error?: (error: Error) => void;
      complete?: () => void;
    };

interface InstanceState {
  broker: MessagingBroker;
  sandbox: Sandbox;
  plane: MessagingPlane;
  /** The registration the last `getToken` or `register` bound to (`deleteToken` / `unregister` target). */
  activeRegistrationId: string;
  onRegisteredHandler: FidObserverLike | null;
  onRegisteredBrokerUnsub: (() => void) | null;
  onUnregisteredHandler: FidObserverLike | null;
  onUnregisteredBrokerUnsub: (() => void) | null;
  own: (cleanup: () => void) => () => void;
}

const instanceState = new WeakMap<Messaging, InstanceState>();
/** One instance per (app, plane); brokers remain shared by sandbox. */
const instancesByApp = new WeakMap<FirebaseApp, Partial<Record<MessagingPlane, Messaging>>>();
const instancesBySandbox = new WeakMap<Sandbox, Partial<Record<MessagingPlane, Messaging>>>();

function isSandboxContext(target: unknown): target is SandboxContext {
  return target instanceof SandboxContextImpl;
}

function isSandbox(target: unknown): target is Sandbox {
  if (target === null || typeof target !== 'object') return false;
  const o = target as Record<string, unknown>;
  return (
    typeof o.withAuth === 'function' &&
    typeof o.onCurrentUserChanged === 'function' &&
    'currentUser' in o &&
    'admin' in o
  );
}

// ── Simulated service-worker registrations ──────────────────────────────────

/**
 * Minimal structural stand-in for a `ServiceWorkerRegistration` in the
 * headless sandbox (bun has no DOM lib). Identity is what matters: token
 * stability is keyed per registration object.
 */
export interface SimulatedServiceWorkerRegistration {
  readonly scope: string;
  readonly active: { readonly state: 'activated' };
}

const registrationIds = new WeakMap<object, string>();
let registrationCounter = 0;

/** Stable id for a registration object, minted on first sight. */
export function registrationIdOf(registration: object): string {
  const existing = registrationIds.get(registration);
  if (existing !== undefined) return existing;
  const id = `swreg-${++registrationCounter}`;
  registrationIds.set(registration, id);
  return id;
}

const DEFAULT_REGISTRATION: SimulatedServiceWorkerRegistration = {
  scope: '/',
  active: { state: 'activated' },
};

/** The module-default simulated registration (what `sandbox.registration()` hands out). */
export function defaultRegistration(): SimulatedServiceWorkerRegistration {
  return DEFAULT_REGISTRATION;
}

// ── Default app ─────────────────────────────────────────────────────────────

function resolveDefaultApp(): FirebaseApp {
  return defaultClientApp() as FirebaseApp;
}

// ── Instance resolution ──────────────────────────────────────────────────────

export function resolveMessaging(plane: MessagingPlane, target?: FirebaseApp | Sandbox | SandboxContext): Messaging {
  const resolved = target ?? resolveDefaultApp();
  if (isSandbox(resolved) || isSandboxContext(resolved)) {
    const sandbox = isSandboxContext(resolved) ? resolved.sandbox : resolved;
    const bySandbox = instancesBySandbox.get(sandbox) ?? {};
    instancesBySandbox.set(sandbox, bySandbox);
    const existing = bySandbox[plane];
    if (existing !== undefined) return existing;

    const broker = getMessagingBroker(sandbox);
    const instance: Messaging = { app: undefined as unknown as FirebaseApp };
    instanceState.set(instance, {
      broker,
      sandbox,
      plane,
      activeRegistrationId: registrationIdOf(DEFAULT_REGISTRATION),
      onRegisteredHandler: null,
      onRegisteredBrokerUnsub: null,
      onUnregisteredHandler: null,
      onUnregisteredBrokerUnsub: null,
      own: (cleanup) => () => { cleanup(); },
    });
    bySandbox[plane] = instance;
    return instance;
  }
  const app = resolved as FirebaseApp;
  const runtime = resolveClientApp(app);
  if (!runtime) throw new TypeError('pyric/messaging: unrecognized FirebaseApp handle');
  const sandbox = runtime.sandbox;
  const byApp = instancesByApp.get(app) ?? {};
  instancesByApp.set(app, byApp);
  const existing = byApp[plane];
  if (existing !== undefined) return existing;
  runtime.assertAlive();

  const broker = getMessagingBroker(sandbox);
  const instance: Messaging = { app };
  instanceState.set(instance, {
    broker,
    sandbox,
    plane,
    activeRegistrationId: registrationIdOf(DEFAULT_REGISTRATION),
    onRegisteredHandler: null,
    onRegisteredBrokerUnsub: null,
    onUnregisteredHandler: null,
    onUnregisteredBrokerUnsub: null,
    own: (cleanup) => runtime.onDelete(cleanup),
  });
  byApp[plane] = instance;
  return instance;
}

/** Bind a broker subscription to its FirebaseApp container lifetime. */
export function ownMessagingSubscription(
  messaging: Messaging,
  subscribe: (state: InstanceState) => () => void,
): () => void {
  const state = stateOf(messaging);
  let stopped = false;
  const backendUnsubscribe = subscribe(state);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    backendUnsubscribe();
  };
  const release = state.own(stop);
  return () => {
    release();
    stop();
  };
}

export function stateOf(messaging: Messaging): InstanceState {
  const state = instanceState.get(messaging);
  if (state === undefined) {
    throw new Error(
      'pyric/messaging: the provided Messaging instance was not produced by ' +
        "this module's getMessaging().",
    );
  }
  return state;
}

function invokeFidObserver(observer: FidObserverLike | null, fid: string): void {
  if (observer === null) {
    return;
  }
  if (typeof observer === 'function') {
    observer(fid);
    return;
  }
  observer.next(fid);
}

/** Whether `onRegistered(messaging, ...)` currently holds an active handler on this instance. */
export function hasOnRegisteredHandler(messaging: Messaging): boolean {
  return stateOf(messaging).onRegisteredHandler !== null;
}

/**
 * Bind a single-slot FID registration/unregistration listener on `messaging`,
 * matching `@firebase/messaging` 0.13.3 (`messaging.onRegisteredHandler = nextOrObserver`,
 * unsub clears only when the current handler still matches `nextOrObserver`).
 */
export function bindFidRegistrationListener(
  messaging: Messaging,
  kind: 'registered' | 'unregistered',
  nextOrObserver: FidObserverLike,
): () => void {
  const state = stateOf(messaging);
  if (kind === 'registered') {
    state.onRegisteredHandler = nextOrObserver;
    if (state.onRegisteredBrokerUnsub === null) {
      state.onRegisteredBrokerUnsub = ownMessagingSubscription(messaging, (s) => {
        const unsub = s.broker.onFidRegistered((fid) => {
          invokeFidObserver(s.onRegisteredHandler, fid);
        });
        return () => {
          unsub();
          s.onRegisteredHandler = null;
          s.onRegisteredBrokerUnsub = null;
        };
      });
    }
    return () => {
      if (state.onRegisteredHandler === nextOrObserver) {
        state.onRegisteredHandler = null;
        state.onRegisteredBrokerUnsub?.();
        state.onRegisteredBrokerUnsub = null;
      }
    };
  }
  state.onUnregisteredHandler = nextOrObserver;
  if (state.onUnregisteredBrokerUnsub === null) {
    state.onUnregisteredBrokerUnsub = ownMessagingSubscription(messaging, (s) => {
      const unsub = s.broker.onFidUnregistered((fid) => {
        invokeFidObserver(s.onUnregisteredHandler, fid);
      });
      return () => {
        unsub();
        s.onUnregisteredHandler = null;
        s.onUnregisteredBrokerUnsub = null;
      };
    });
  }
  return () => {
    if (state.onUnregisteredHandler === nextOrObserver) {
      state.onUnregisteredHandler = null;
      state.onUnregisteredBrokerUnsub?.();
      state.onUnregisteredBrokerUnsub = null;
    }
  };
}

// ── Transport-delivery hook (the `@pyric/cli` worker seam) ──────────────────

/**
 * A `sandbox.deliver` implementation for a `Messaging` handle whose broker
 * lives across a transport, rather than in this process's instance registry.
 */
export type SandboxDeliveryTransport = (spec: DeliverSpec) => Promise<DeliveryResult>;

/**
 * Handles produced OUTSIDE this module (the `@pyric/cli` worker-backed
 * messaging handle) register their own delivery here so `sandbox.deliver`
 * recognizes them without their being in the in-page {@link instanceState}
 * registry. The registered transport receives the FULL {@link DeliverSpec}
 * (visibility included) and owns the visibility+deliver routing on the far
 * side of the transport. This is an internal seam (`pyric/messaging/internal`),
 * never part of the app-facing `firebase/messaging` surface.
 */
const transportDelivery = new WeakMap<Messaging, SandboxDeliveryTransport>();

/** Register a worker-backed handle's `sandbox.deliver` transport. */
export function registerSandboxDelivery(
  messaging: Messaging,
  deliver: SandboxDeliveryTransport,
): void {
  transportDelivery.set(messaging, deliver);
}

// ── The sandbox test/tooling driver shared by both entries ──────────────────

export interface DeliverSpec {
  /** Simulated visibility of the (single) window client at delivery time. */
  visibilityState?: 'visible' | 'hidden';
  data?: Record<string, string>;
  notification?: { title?: string; body?: string; image?: string };
  from?: string;
  messageId?: string;
}

/**
 * Drive a delivery into the client plane, optionally setting the simulated
 * window client's visibility first — the headless stand-in for "a push
 * arrives while the page is visible/hidden". Routing then follows the
 * captured visibility rule inside the broker.
 */
export async function deliverToMessaging(
  messaging: Messaging,
  spec: DeliverSpec,
): Promise<DeliveryResult> {
  // A worker-backed handle drives its broker across the transport — routing
  // (visibility → foreground/background) happens on the far side.
  const transport = transportDelivery.get(messaging);
  if (transport !== undefined) return transport(spec);
  const state = stateOf(messaging);
  if (spec.visibilityState !== undefined) {
    state.broker.setClientVisibility(DEFAULT_CLIENT_ID, spec.visibilityState);
  }
  const { visibilityState: _visibility, ...payload } = spec;
  return state.broker.deliver(payload);
}
