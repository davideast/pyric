/**
 * Shared plumbing for the two receive-plane mirror entries
 * (`pyric/messaging` — window client — and `pyric/messaging/sw` — service
 * worker). Both entries bind to the SAME per-sandbox {@link MessagingBroker},
 * mirroring production's one-service-worker-per-origin model: a window
 * `onMessage` handler and a sw `onBackgroundMessage` handler registered
 * against the same sandbox observe the same delivery stream, routed
 * exclusively by client visibility (the captured rule).
 *
 * ── Default instance (the in-process degenerate case) ──────────────────────
 * `getMessaging()` with no app mirrors `firebase/messaging`'s default-app
 * form. `pyric/app` has no default-app registry yet, so the mirror keeps a
 * module-level default sandbox — but ONLY under `PYRIC_CLIMB=1` (the
 * conformance-climb flag). Outside the climb, the bare call throws with
 * remediation instead of silently minting a sandbox: this keeps the WIP
 * messaging surface isolated (owner's isolation decision) and preserves
 * the house rule that backend selection happens at `initializeApp` time.
 */
import { initializeApp, isSandboxApp, type PyricApp, type SandboxApp } from '../app/index.js';
import { initializeSandbox } from '../sandbox/index.js';
import type { Sandbox } from '../sandbox/types.js';
import { DEFAULT_CLIENT_ID, getMessagingBroker, MessagingBroker } from './broker/index.js';
import type { DeliveredPayload, DeliveryResult } from './broker/index.js';

/**
 * The FCM `Messaging` instance mirror — exposes the bound app as `app`
 * (upstream `@firebase/messaging` public-types parity).
 */
export interface Messaging {
  readonly app: PyricApp;
}

export type MessagingPlane = 'window' | 'sw';

interface InstanceState {
  broker: MessagingBroker;
  sandbox: Sandbox;
  plane: MessagingPlane;
  /** The registration the last `getToken` bound to (deleteToken's target). */
  activeRegistrationId: string;
}

const instanceState = new WeakMap<Messaging, InstanceState>();
/** One instance per (sandbox, plane) so repeated `getMessaging()` calls share state. */
const instancesBySandbox = new WeakMap<Sandbox, Partial<Record<MessagingPlane, Messaging>>>();

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

// ── Default app (climb-gated) ────────────────────────────────────────────────

let defaultApp: SandboxApp | null = null;

function resolveDefaultApp(): PyricApp {
  if (defaultApp !== null) return defaultApp;
  // `typeof` guard: this entry also loads in browser contexts, where
  // `process` does not exist — the bare call must throw the remediation
  // error below, not a ReferenceError.
  const climb = typeof process !== 'undefined' && process.env.PYRIC_CLIMB === '1';
  if (!climb) {
    throw new Error(
      'pyric/messaging: getMessaging() was called without an app and no default ' +
        'exists. Pass initializeApp({ sandbox: initializeSandbox() }) from ' +
        "'pyric/app', or set PYRIC_CLIMB=1 to enable the conformance-climb " +
        'default sandbox (WIP surface).',
    );
  }
  defaultApp = initializeApp({ sandbox: initializeSandbox() }) as SandboxApp;
  return defaultApp;
}

// ── Instance resolution ──────────────────────────────────────────────────────

export function resolveMessaging(plane: MessagingPlane, app?: PyricApp): Messaging {
  const resolved = app ?? resolveDefaultApp();
  if (!isSandboxApp(resolved)) {
    throw new Error(
      'pyric/messaging: the prod arm is not implemented in this slice — the FCM ' +
        'receive plane requires a browser context. Pass a sandbox-backed app ' +
        '(initializeApp({ sandbox })).',
    );
  }
  const bySandbox = instancesBySandbox.get(resolved.sandbox) ?? {};
  instancesBySandbox.set(resolved.sandbox, bySandbox);
  const existing = bySandbox[plane];
  if (existing !== undefined) return existing;

  const broker = getMessagingBroker(resolved.sandbox);
  const instance: Messaging = { app: resolved };
  instanceState.set(instance, {
    broker,
    sandbox: resolved.sandbox,
    plane,
    activeRegistrationId: registrationIdOf(DEFAULT_REGISTRATION),
  });
  bySandbox[plane] = instance;
  return instance;
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
  const state = stateOf(messaging);
  if (spec.visibilityState !== undefined) {
    state.broker.setClientVisibility(DEFAULT_CLIENT_ID, spec.visibilityState);
  }
  const { visibilityState: _visibility, ...payload } = spec;
  return state.broker.deliver(payload);
}

export type { DeliveredPayload, DeliveryResult };
