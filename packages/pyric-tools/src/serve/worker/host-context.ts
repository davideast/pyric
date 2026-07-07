/**
 * SharedWorker host — shared foundation (context + reply helpers).
 *
 * The `HostCtx` is the single per-worker context shared across ALL connected
 * ports and across the auth + event-stream subsystems. `PortLike`, `post`,
 * `ok`, and `fail` are the minimal port + reply primitives every subsystem
 * uses. This module imports NOTHING from the sibling `host-*` files, so it is
 * the dependency root (no circular imports).
 */

import type { Firestore } from 'pyric/firestore';
import type { Database } from 'pyric/database/modular';
import type { Sandbox, PersistenceBackend } from 'pyric/sandbox';
import type { Auth, MintedSession } from 'pyric/auth';
import type { FirebaseStorage } from 'pyric/storage';
import {
  serializeError,
  type OutboundMessage,
  type AuthPersistenceMode,
  type PolicyRequest,
} from './protocol.js';

// ─── Port interface ───────────────────────────────────────────────────────

/** Minimal postMessage interface. Fake ports in tests implement this. */
export interface PortLike {
  postMessage(msg: OutboundMessage): void;
}

// ─── Host context ─────────────────────────────────────────────────────────

export interface HostCtx {
  /** The single shared Firestore handle (sandbox-live — reads currentUser per op). */
  db: Firestore;
  /** The underlying Sandbox, for setRules + direct sandbox ops. */
  sandbox: Sandbox;
  /** Stable per-SharedWorker instance id (see {@link INSTANCE_ID_KEY}). Reported
   *  via `getVersion` so the UI can identify which sandbox instance this is. */
  instanceId: string;
  /** The shared Storage handle (Pyric Studio data browse). Lazily created on
   *  the first storage op via `getStorage(initializeApp({ sandbox }))`. */
  storage?: FirebaseStorage;
  /** Shared RTDB handle. Lazily created for the playground shared-runtime path. */
  rtdb?: Database;
  /** Cached admin (rules-bypass) RTDB handle for Studio/Playground data inspection. */
  adminRtdb?: Database;
  /** Per-uid RTDB handles carrying a port session's real identity. */
  sessionRtdbs?: Map<string, Database>;
  /** Per-uid/token RTDB handles for the Studio impersonation lens. */
  lensRtdbs?: Map<string, Database>;
  /** Current active rules metadata for shared-runtime diagnostics and revert. */
  activeRules?: {
    firestore?: ActiveRulesState;
    database?: ActiveRulesState;
  };
  /** Per-port subscription registry. Map<port, Map<subId, unsub>>. */
  subs: Map<PortLike, Map<string, () => void>>;
  /**
   * The ONE shared auth handle for the worker — the USER POOL (who exists)
   * and the admin surface. Lazily created on first auth op or auth
   * subscription. Sessions (who a connection IS) are per-port: see
   * {@link HostCtx.portSessions} (#754). The handle's own `currentUser`
   * stays null in served mode.
   */
  auth?: Auth;
  /**
   * Per-connection identity (#754): each port's signed-in session, minted
   * via `sandbox.mintSession` (an authentic session — validated
   * credentials / a really-minted identity, NOT the impersonation lens).
   * A port absent from the map, or mapped to null, is signed out. The
   * user pool + data + rules stay shared across ports.
   */
  portSessions?: Map<PortLike, MintedSession | null>;
  /**
   * Re-establish a port's session-bound Firestore listeners under its NEW
   * session (#754) — set lazily by host.ts (which owns subs) and invoked by
   * host-auth.ts on every port session change, mirroring prod's stream
   * re-establishment on auth transitions: a sign-out re-evaluates live
   * listeners so an auth-gated stream loses access instead of leaking the
   * previous user's data. (A ctx hook, not an import — host-auth must not
   * import host.ts.)
   */
  resubscribePortSubs?: (port: PortLike) => void;
  /**
   * Per-uid Firestore handles carrying a PORT SESSION's identity —
   * `getFirestore(sandbox.withAuth(session.state))`, so rules see the
   * session's uid AND its custom claims on `request.auth.token`. Keyed by
   * uid (two ports as the same user share one handle). Distinct from
   * {@link HostCtx.lensHandles}, which is the Studio debugging lens
   * (uid-only, caller-gated writes).
   */
  sessionDbs?: Map<string, Firestore>;
  /**
   * The backend used for named state branches (save/switch). Session
   * persistence is NOT here anymore: per-tab sessions persist client-side
   * in web storage (the page restores via `auth.restorePortSession`),
   * mirroring how the real SDK owns persistence in the client (#754).
   */
  sessionBackend?: PersistenceBackend;
  /**
   * Accepted `auth.setPersistence` mode, kept for surface parity. The
   * worker itself no longer writes a session record — the CLIENT's
   * SessionStore honors the mode (which web storage slot, or none).
   */
  sessionMode?: AuthPersistenceMode;
  /**
   * Per-uid impersonation Firestore handles (Pyric Studio auth lens, T2).
   * Keyed by the impersonated uid. Each is a FROZEN-identity
   * `getFirestore(sandbox.withAuth({ uid }))` handle whose ops evaluate
   * security rules AS that user — the rules-debugging primitive. Cached so
   * repeated `{ mode: 'as', uid }` ops reuse one handle (and so the modular
   * layer's per-ctx ref cache stays warm). Lazily populated by `lensDb`.
   */
  lensHandles?: Map<string, Firestore>;
  /**
   * Cached admin (rules-bypass) Firestore handle for the `{ mode: 'admin' }`
   * lens (Pyric Studio, Gap #2). A modular `getAdminFirestore(sandbox)` handle
   * whose ops skip security-rule evaluation — Studio's "edit anything as admin"
   * (F2). Lazily populated by `lensDb`.
   */
  adminDb?: Firestore;
  /**
   * The latest runtime confirm-policy pushed by the Studio permission dial
   * (F3) via the `set-policy` op. `undefined` until the dial sets one. This is
   * the WORKER-SIDE governance store — the source of truth Studio reflects and a
   * future in-worker agent runtime would consult.
   *
   * HONEST LIMITATION: the interactive policy that gates AGENT TOOL CALLS lives
   * in the bridge — a SEPARATE node process whose handler is built once at
   * startup. This store does NOT reach into a running bridge; pushing a live
   * policy there is a separate transport (an HTTP control route or a restart).
   * See `PolicyRequest` in protocol.ts for the full rationale.
   */
  policy?: PolicyRequest;
  /**
   * Lazily-built agent tool dispatcher (the canonical sandbox tool set) bound to
   * THIS worker's sandbox. The bridge peer forwards `tool` messages here so the
   * agent executes against the one shared sandbox, not a separate in-page
   * backend. Cached so the handler array is built once.
   */
  toolDispatch?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; summary: string; data?: unknown }>;
}

export interface ActiveRulesState {
  source: unknown;
  updatedAt: number;
  status: 'active' | 'error';
  messages: Array<{ severity: 'info' | 'warn' | 'error'; text: string; line?: number; column?: number }>;
  lastKnownGood?: unknown;
}

// ─── Utility: post a typed reply to a port ───────────────────────────────

export function post(port: PortLike, msg: OutboundMessage): void {
  port.postMessage(msg);
}

export function ok(port: PortLike, id: string, value: unknown): void {
  post(port, { t: 'res', id, ok: true, value });
}

export function fail(port: PortLike, id: string, err: unknown): void {
  const { code, message } = serializeError(err);
  post(port, { t: 'res', id, ok: false, error: { code, message } });
}
