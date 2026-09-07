/**
 * The identity operations behind `auth_impersonate`, `auth_reset`,
 * `auth_whoami`, and `auth_sessions`, and behind the `pyric auth` commands of
 * the same names. One implementation, two surfaces.
 *
 * WHAT AN IDENTITY HERE ACTUALLY GOVERNS. Two different mechanisms, one per
 * scope.
 *
 * A TARGETED identity is a registry write. The bridge keeps an `activeLens`
 * per connected client (a mobile runtime, a Studio tab, a Node client);
 * writing it stores the value and sends that client a
 * `worker-event`/`remote-lens` frame, and the client's own SDK is what decides
 * to stamp `actAs` on the worker ops it subsequently sends
 * (`packages/cli/src/serve/worker/host/core.ts` reads that per-operation
 * `actAs`, not the registry). Nothing about the caller's own calls changes.
 *
 * The CALLER'S OWN identity is read on the dispatch path. `dispatchSandbox()`
 * puts anything other than the default `{ mode: 'app-session' }` on the
 * forwarded frame as `actAs` (`packages/cli/src/bridge/server/bridge.ts`), the
 * peer relays it to the agent tool dispatcher
 * (`packages/cli/src/bridge/client/dispatch.ts`), and the dispatcher binds the
 * tool's Firestore handle to it. That is a DIFFERENT seam from the worker's
 * `lensDb`: the agent tool surface names its own identity argument (`as`), and
 * a call that supplies one still wins for that call.
 *
 * So the identity governs exactly the forwarded tools that HAVE that seam —
 * the Firestore data family. `sandbox_inspect`, the rules simulator, the
 * Realtime Database inspectors, and the auth user-administration tools are
 * administrative surfaces with no identity argument, and they keep bypassing
 * rules. Both surfaces say all of this, in {@link SELF_SCOPE_NOTE} and
 * {@link TARGET_SCOPE_NOTE}.
 *
 * The registry and the caller identity are both bridge-process state, so
 * these operations are in-process and are meaningless without a running
 * bridge. Both surfaces degrade with {@link NO_BRIDGE_MESSAGE} rather than
 * throwing.
 *
 * `AuthLens` is the internal type name for the stored value, shared with the
 * worker protocol. It is deliberately absent from every message, argument,
 * and field name below.
 */

import type { AuthLens } from 'pyric/sandbox';

/** One connected client, as the surfaces report it. Mirrors `RemoteConsumerRecord`. */
export interface SessionRecord {
  clientSessionId: string;
  platform: string;
  deviceLabel?: string;
  connectedAt: number;
  lastSeen: number;
  activeLens: AuthLens;
}

/**
 * The slice of the bridge's `ConsumerRegistry` these operations need.
 * `createConsumerRegistry()` satisfies it structurally.
 */
export interface SessionRegistry {
  list(): SessionRecord[];
  setLens(clientSessionId: string, lens: AuthLens): boolean;
}

/**
 * The identity the bridge attributes to its own MCP callers. Held per bridge
 * so the CLI and an agent talking to the same bridge read the same answer
 * from `auth_whoami`.
 */
export interface CallerIdentityStore {
  get(): AuthLens;
  set(identity: AuthLens): void;
}

export function createCallerIdentity(): CallerIdentityStore {
  let identity: AuthLens = { mode: 'app-session' };
  return {
    get: () => identity,
    set: (next) => {
      identity = next;
    },
  };
}

export interface IdentityResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export const NO_BRIDGE_MESSAGE =
  'No bridge is running in this process, so there is no client registry to read. ' +
  'Identities exist only while `pyric sandbox --bridge` (or `pyric bridge`) is running.';

export const NO_BRIDGE_CLI_MESSAGE =
  'pyric auth: no running sandbox bridge found. ' +
  'Start one with `pyric sandbox --bridge` in the project directory, then retry.';

/**
 * What both surfaces must keep saying about a call with no `target`. The
 * bridge stamps the caller's identity on every tool call it forwards, so this
 * describes the reach of that stamp: the tools that take an identity, the
 * per-call argument that outranks it, and the tools it does not touch.
 */
export const SELF_SCOPE_NOTE =
  'Recorded for your own bridge session and applied to the tool calls you forward through it: ' +
  'the Firestore data tools run under this identity with Security Rules enforced, and admin ' +
  'bypasses them. A call that passes its own as argument uses that instead, and the recorded ' +
  'identity is unchanged. sandbox_inspect, the rules simulator, the Realtime Database ' +
  'inspectors, and the auth user tools take no identity and keep bypassing rules.';

/** The scope of a call that names another connected client instead. */
export const TARGET_SCOPE_NOTE =
  'This applies to the named client only. It does not change how your own tool calls are ' +
  'rules-evaluated; call this without a target for that.';

function failure(code: string, message: string): IdentityResult {
  return { ok: false, summary: message, data: { code } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type IdentityParse = { ok: true; identity: AuthLens } | { ok: false; result: IdentityResult };

/**
 * Build the identity an impersonation request describes. Exactly one of
 * `uid`, `admin: true`, and `anonymous: true` selects the identity; `tenant`
 * and `claims` refine `uid` only, and are the Identity Platform tenant and
 * custom-claim fields rules evaluation reads.
 */
export function parseImpersonation(input: unknown, command: string): IdentityParse {
  const source = isPlainObject(input) ? input : {};
  const uid = source.uid;
  const wantsUid = uid !== undefined;
  const wantsAdmin = source.admin === true;
  const wantsAnonymous = source.anonymous === true;
  const selected = [wantsUid, wantsAdmin, wantsAnonymous].filter(Boolean).length;

  if (selected !== 1) {
    return {
      ok: false,
      result: failure(
        'auth/argument-error',
        `${command}: supply exactly one of uid, admin: true, or anonymous: true` +
          (selected === 0 ? '.' : `; got ${selected}.`),
      ),
    };
  }

  if (!wantsUid) {
    if (source.tenant !== undefined || source.claims !== undefined) {
      return {
        ok: false,
        result: failure(
          'auth/argument-error',
          `${command}: tenant and claims describe an impersonated user, so they require uid.`,
        ),
      };
    }
    return { ok: true, identity: { mode: wantsAdmin ? 'admin' : 'anon' } };
  }

  if (typeof uid !== 'string' || uid.length === 0) {
    return {
      ok: false,
      result: failure('auth/argument-error', `${command}: uid must be a non-empty string.`),
    };
  }
  const tenant = source.tenant;
  if (tenant !== undefined && (typeof tenant !== 'string' || tenant.length === 0)) {
    return {
      ok: false,
      result: failure('auth/argument-error', `${command}: tenant must be a non-empty string.`),
    };
  }
  const claims = source.claims;
  if (claims !== undefined && !isPlainObject(claims)) {
    return {
      ok: false,
      result: failure('auth/argument-error', `${command}: claims must be an object.`),
    };
  }
  return {
    ok: true,
    identity: {
      mode: 'as',
      uid,
      ...(tenant !== undefined ? { tenant } : {}),
      ...(claims !== undefined ? { token: claims } : {}),
    },
  };
}

/** Human-readable one-line rendering of an identity, shared by both surfaces. */
export function describeIdentity(identity: AuthLens | undefined): string {
  if (!identity) return 'unknown';
  if (identity.mode === 'admin') return 'admin';
  if (identity.mode === 'anon') return 'anonymous';
  if (identity.mode === 'app-session') return 'app session';
  const parts = [`as ${identity.uid}`];
  if (identity.tenant) parts.push(`tenant ${identity.tenant}`);
  const claims = identity.token ? Object.keys(identity.token) : [];
  if (claims.length > 0) parts.push(`claims ${claims.join(',')}`);
  return parts.join(' · ');
}

/** Every connected client with the identity the bridge holds for it. */
export function listSessions(registry: SessionRegistry | undefined): IdentityResult {
  if (!registry) return failure('auth/no-bridge', NO_BRIDGE_MESSAGE);
  const sessions = registry.list().map((session) => ({
    target: session.clientSessionId,
    platform: session.platform,
    ...(session.deviceLabel !== undefined ? { deviceLabel: session.deviceLabel } : {}),
    connectedAt: session.connectedAt,
    lastSeen: session.lastSeen,
    identity: describeIdentity(session.activeLens),
    identityDetail: session.activeLens,
  }));
  return {
    ok: true,
    summary:
      sessions.length === 0
        ? 'No clients are connected to this bridge.'
        : `${sessions.length} connected client${sessions.length === 1 ? '' : 's'}`,
    data: { sessions, total: sessions.length },
  };
}

/**
 * Point one connected client at an identity. Reports `auth/unknown-session`
 * when no client holds that target id, listing the ids that are connected so
 * a caller can correct the argument without a second round trip.
 */
export function setSessionIdentity(
  registry: SessionRegistry | undefined,
  target: unknown,
  identity: AuthLens,
  command: string,
): IdentityResult {
  if (!registry) return failure('auth/no-bridge', NO_BRIDGE_MESSAGE);
  if (typeof target !== 'string' || target.length === 0) {
    return failure('auth/argument-error', `${command}: target must be a non-empty string.`);
  }
  if (!registry.setLens(target, identity)) {
    const connected = registry.list().map((session) => session.clientSessionId);
    return {
      ok: false,
      summary:
        `No connected client has target id ${target}. ` +
        (connected.length === 0
          ? 'No clients are connected.'
          : `Connected: ${connected.join(', ')}.`),
      data: { code: 'auth/unknown-session', connected },
    };
  }
  return {
    ok: true,
    summary: `${target} now acts as ${describeIdentity(identity)}. ${TARGET_SCOPE_NOTE}`,
    data: { target, identity: describeIdentity(identity), identityDetail: identity },
  };
}

/** Record the identity the bridge attributes to its own MCP callers. */
export function setCallerIdentity(
  caller: CallerIdentityStore | undefined,
  identity: AuthLens,
): IdentityResult {
  if (!caller) return failure('auth/no-bridge', NO_BRIDGE_MESSAGE);
  caller.set(identity);
  return {
    ok: true,
    summary: `You now act as ${describeIdentity(identity)}. ${SELF_SCOPE_NOTE}`,
    data: { identity: describeIdentity(identity), identityDetail: identity, appliesTo: 'self' },
  };
}

/** The identity the bridge holds for the caller, with the same caveat attached. */
export function readCallerIdentity(caller: CallerIdentityStore | undefined): IdentityResult {
  if (!caller) return failure('auth/no-bridge', NO_BRIDGE_MESSAGE);
  const identity = caller.get();
  return {
    ok: true,
    summary: `You act as ${describeIdentity(identity)}. ${SELF_SCOPE_NOTE}`,
    data: { identity: describeIdentity(identity), identityDetail: identity, appliesTo: 'self' },
  };
}
