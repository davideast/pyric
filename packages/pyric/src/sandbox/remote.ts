/**
 * Remote-sandbox brand + channel contract (remote sandbox, slice 1).
 *
 * A REMOTE sandbox is a Node-side handle onto the browser-hosted
 * SharedWorker sandbox, constructed by `@pyric/cli`'s
 * `connectRemoteSandbox()`. It satisfies {@link Sandbox} structurally, but
 * its data plane lives in the browser worker — so consumers that keep
 * process-local state keyed off the `Sandbox` object (`pyric-admin`'s RTDB
 * and Auth sandbox backends) must NOT treat it like an in-process sandbox:
 * doing so would create a private server-side data store that never reaches
 * the browser.
 *
 * This module is the dependency seam that lets `pyric-admin` (which depends
 * only on `pyric` + `firebase-admin`) recognize a handle constructed by
 * `@pyric/cli` (which depends on `pyric`):
 *
 *   - {@link REMOTE_SANDBOX} — a `Symbol.for` brand, so the stamp and the
 *     check agree across package boundaries and duplicated module graphs.
 *   - {@link RemoteSandboxChannel} — a STRUCTURALLY-typed minimal op/sub
 *     relay interface matching `@pyric/cli/remote`'s channel shape. The
 *     concrete op/sub payload types live in `@pyric/cli`' worker protocol;
 *     this contract deliberately types them loosely (`method` + open
 *     fields) so `pyric` carries no dependency on `@pyric/cli`.
 *
 * No runtime imports beyond this package's own types — the only runtime
 * export is the brand symbol and its guard.
 */

import type { Sandbox } from './types/service.js';

/**
 * Brand stamped (value `true`) on every remote sandbox handle.
 * `Symbol.for` — registered globally so `pyric-admin`'s check matches the
 * stamp even if two copies of `pyric` end up in one process.
 */
export const REMOTE_SANDBOX = Symbol.for('pyric.remote.sandbox');

/**
 * The minimal worker-relay channel a remote sandbox handle carries.
 *
 * Structural mirror of `@pyric/cli/remote`'s `RemoteSandboxChannel`: one
 * method to dispatch any SharedWorker-protocol op, one to register a
 * snap-delivering subscription. Payloads are typed openly here (the real
 * discriminated unions live in `@pyric/cli`' worker protocol); callers in
 * `pyric-admin` spell the concrete op objects (`rtdb.set`, `auth.listUsers`,
 * …) and pin their own `actAs` lens — nothing is pinned by the channel.
 */
export interface RemoteSandboxChannel {
  /**
   * Dispatch one worker op. Resolves with the worker's result value;
   * rejects with an `Error` carrying a `.code` (including the fail-fast
   * "no browser tab is connected — open <serve url>" guidance when no
   * peer is registered).
   */
  op(op: { method: string } & Record<string, unknown>): Promise<unknown>;

  /**
   * Register a worker subscription (e.g. an RTDB value listener:
   * `{ target: { service: 'rtdb', path } }`). `onSnap` receives every snap
   * value (initial + updates — and re-delivered fresh after peer
   * replacement); an establishment failure routes to `onError` instead.
   * Returns the unsubscribe function.
   */
  subscribe(
    sub: { target: unknown } & Record<string, unknown>,
    onSnap: (value: unknown) => void,
    onError?: (err: Error & { code: string }) => void,
  ): () => void;
}

/**
 * A branded remote sandbox handle. Structurally a {@link Sandbox} — it can
 * be passed anywhere a `Sandbox` is accepted (notably
 * `pyric-admin/app`'s `initializeApp({ sandbox })`) — but sync-only members
 * that cannot be mirrored over the wire (`admin`, `snapshot()`,
 * `history()`, …) throw a remediating error. Consumers with a remote arm
 * dispatch on {@link isRemoteSandbox} and use {@link channel} instead.
 */
export interface RemoteSandbox extends Sandbox {
  readonly [REMOTE_SANDBOX]: true;
  /** Base URL of the `pyric sandbox` this handle is attached to (used in
   *  error guidance: "open <serveUrl> in a browser and retry"). */
  readonly serveUrl: string;
  /** The raw worker op/sub relay channel. */
  readonly channel: RemoteSandboxChannel;
}

/**
 * Well-known global key under which `@pyric/cli/register` installs the
 * remote-sandbox factory: `globalThis[REMOTE_SANDBOX_FACTORY]`.
 *
 * This is the AMBIENT-INIT seam (adoption experience, layer 3): when
 * `pyric-admin/app`'s bare `initializeApp()` sees `PYRIC_SANDBOX=remote[:url]`
 * it reads this global and calls the installed {@link RemoteSandboxFactory}
 * to obtain the branded handle — without importing `@pyric/cli` (which is
 * a devDependency of the app, not of `pyric-admin`). `Symbol.for` so the
 * installer and the reader agree even across duplicated copies of `pyric`.
 */
export const REMOTE_SANDBOX_FACTORY = Symbol.for('pyric.remote.sandboxFactory');

/** Options accepted by the ambient remote-sandbox factory. */
export interface RemoteSandboxFactoryOptions {
  /** Explicit `pyric sandbox` base URL (from `PYRIC_SANDBOX=remote:<url>`).
   *  When omitted the factory discovers the running host itself (the
   *  `.pyric/serve.json` locator protocol). */
  url?: string;
}

/**
 * The factory `@pyric/cli/register` installs at
 * `globalThis[`{@link REMOTE_SANDBOX_FACTORY}`]`. SYNCHRONOUS by contract:
 * `initializeApp()` is sync in firebase-admin, so the factory must return
 * the branded handle without awaiting (connection establishment may be
 * lazy inside the handle's channel).
 */
export type RemoteSandboxFactory = (
  opts?: RemoteSandboxFactoryOptions,
) => RemoteSandbox;

/**
 * Is this sandbox a remote handle? Backend dispatch guard for consumers
 * (e.g. `pyric-admin`'s RTDB/Auth sandbox backends) that must route a
 * remote sandbox's operations through {@link RemoteSandbox.channel} rather
 * than into process-local state.
 */
export function isRemoteSandbox(sandbox: Sandbox): sandbox is RemoteSandbox {
  // Null-safe by contract: guard call sites probe values that may not be a
  // Sandbox at all (e.g. legacy callers passing a raw Sandbox where a
  // SandboxContext is expected leave `.sandbox` undefined). A brand check
  // must classify, never throw.
  return (
    sandbox != null &&
    (sandbox as Partial<Record<typeof REMOTE_SANDBOX, unknown>>)[
      REMOTE_SANDBOX
    ] === true
  );
}
