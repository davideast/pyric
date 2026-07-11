/**
 * Worker-backed messaging client — the import the sandbox demo variant uses
 * IN PLACE of `firebase/messaging`.
 *
 * Presents the `pyric/messaging` API shape (getMessaging / getToken /
 * deleteToken / onMessage, plus the sw entry's onBackgroundMessage and the
 * send-plane driver) implemented over the SharedWorker port: each call is
 * one `messaging.*` op from `serve/worker/protocol.ts`, each handler a
 * `messaging.foreground` / `messaging.background` sub. This is the CLIENT
 * half of the broker's documented worker-host seam — the prototype of the
 * in-page mirror `pyric dev`'s SDK bundle will eventually serve for bare
 * `firebase/messaging` imports. Once that mirror lands, the REAL demo page
 * runs unchanged (the graduation criterion) and this module retires.
 *
 * Engine-free by construction: no pyric import crosses into the page
 * bundle — the whole sandbox lives in the worker.
 */

// ── Wire types (mirrors serve/worker/protocol.ts — plain JSON only) ───────

export interface MessagePayload {
  notification?: { title?: string; body?: string; image?: string };
  data?: Record<string, string>;
  from: string;
  messageId: string;
}

export interface AcceptedSend {
  name: string;
  messageId: string;
  validateOnly: boolean;
}

interface ResMessage {
  t: 'res';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; envelope?: unknown };
}

interface SnapMessage {
  t: 'snap';
  subId: string;
  value: unknown;
}

/** Send-plane rejection carrying the broker's captured google.rpc envelope. */
export class MessagingSendError extends Error {
  readonly code: string;
  readonly envelope: unknown;
  constructor(error: { code: string; message: string; envelope?: unknown }) {
    super(error.message);
    this.name = 'MessagingSendError';
    this.code = error.code;
    this.envelope = error.envelope;
  }
}

// ── The worker-bound Messaging instance ────────────────────────────────────

export interface Messaging {
  readonly port: MessagePort;
}

interface State {
  port: MessagePort;
  nextId: number;
  pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  subs: Map<string, (payload: MessagePayload) => void>;
  /** Sub-channel error hook (e.g. the climb gate arriving as a snap __error). */
  onError?: (e: MessagingSendError) => void;
}

const states = new WeakMap<Messaging, State>();

/** Connect the page to the served SharedWorker sandbox host. */
export function getMessaging(workerUrl = '/worker.js'): Messaging {
  const worker = new SharedWorker(workerUrl, 'pyric-sandbox');
  const port = worker.port;
  port.start();
  const state: State = { port, nextId: 0, pending: new Map(), subs: new Map() };
  port.onmessage = (ev: MessageEvent<ResMessage | SnapMessage>) => {
    const msg = ev.data;
    if (msg.t === 'res') {
      const waiter = state.pending.get(msg.id);
      if (!waiter) return;
      state.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new MessagingSendError(msg.error!));
    } else if (msg.t === 'snap') {
      const err = (msg.value as { __error?: { code: string; message: string } })?.__error;
      if (err) {
        state.onError?.(new MessagingSendError(err));
        return;
      }
      state.subs.get(msg.subId)?.(msg.value as MessagePayload);
    }
  };
  const messaging: Messaging = { port };
  states.set(messaging, state);
  return messaging;
}

function op<T>(messaging: Messaging, payload: Record<string, unknown>): Promise<T> {
  const state = states.get(messaging)!;
  const id = `m-${++state.nextId}`;
  return new Promise<T>((resolve, reject) => {
    state.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    state.port.postMessage({ ...payload, t: 'op', id });
  });
}

function sub(messaging: Messaging, target: string, cb: (p: MessagePayload) => void): () => void {
  const state = states.get(messaging)!;
  const subId = `ms-${++state.nextId}`;
  state.subs.set(subId, cb);
  state.port.postMessage({ t: 'sub', subId, target });
  return () => {
    state.subs.delete(subId);
    state.port.postMessage({ t: 'unsub', subId });
  };
}

// ── The pyric/messaging-shaped surface ─────────────────────────────────────

export interface GetTokenOptions {
  vapidKey?: string; // accepted for signature parity; the sandbox needs none
  serviceWorkerRegistration?: { scope?: string };
}

export async function getToken(messaging: Messaging, options?: GetTokenOptions): Promise<string> {
  // Token stability keys on the registration identity; the page's (single)
  // registration maps to one stable wire id.
  const registrationId = options?.serviceWorkerRegistration?.scope ?? 'swreg-demo-page';
  const { token } = await op<{ token: string }>(messaging, {
    method: 'messaging.getToken',
    registrationId,
  });
  return token;
}

export function deleteToken(messaging: Messaging, registrationId = 'swreg-demo-page'): Promise<boolean> {
  return op<boolean>(messaging, { method: 'messaging.deleteToken', registrationId });
}

export function onMessage(messaging: Messaging, cb: (p: MessagePayload) => void): () => void {
  return sub(messaging, 'messaging.foreground', cb);
}

/** The sw entry's handler — over the transport it is the broker's background
 *  route delivered to this port (no real service worker stands in). */
export function onBackgroundMessage(messaging: Messaging, cb: (p: MessagePayload) => void): () => void {
  return sub(messaging, 'messaging.background', cb);
}

/** Send-plane driver (the demo harness's firebase-admin stand-in): message
 *  intake goes to the SAME broker that routes deliveries back to this page. */
export function send(
  messaging: Messaging,
  message: Record<string, unknown>,
  options?: { validateOnly?: boolean },
): Promise<AcceptedSend> {
  return op<AcceptedSend>(messaging, {
    method: 'messaging.send',
    message,
    ...(options?.validateOnly !== undefined ? { validateOnly: options.validateOnly } : {}),
  });
}

/** Report this tab's visibility — the captured routing rule's ONLY input.
 *  Pages call it now + on every `visibilitychange`. */
export function setVisibility(messaging: Messaging, state: 'visible' | 'hidden'): Promise<null> {
  return op<null>(messaging, { method: 'messaging.setVisibility', state });
}

/** Register the sub-channel error hook (gate errors arrive as snap errors). */
export function onError(messaging: Messaging, cb: (e: MessagingSendError) => void): void {
  states.get(messaging)!.onError = cb;
}
