/**
 * The host's one Firebase config.
 *
 * Every app port shares one backend, so the host serves one config: the first
 * one an app port sends. Configs are compared on the keys that pick backend
 * data (`backend-options.ts`), so a page that adds `measurementId` shares a
 * server process's config. Who sent it decides whether a later, different
 * config may replace it:
 *
 * - A client verified against this host boot (it presented this host's
 *   instance id on attach: a page the host served, or a Node process that
 *   read this host's `init.json`) holds the config. A later client with a
 *   different config is the one refused, whether it is a page or a Node process.
 * - A client that re-attached from an earlier host boot, or that presented no
 *   instance id (a Service Worker woken from an older cached bundle), holds it
 *   provisionally. The first verified client replaces it, and the provisional
 *   clients on the old config are evicted (#1153).
 *
 * A refused client whose config the replacing client turns out to share is
 * accepted again, so it is not stuck behind a provisional lock that is gone.
 * When the last connected client on the config disconnects (a script that
 * exited, the last tab closed) and none with the config attaches within a
 * short grace (a reloading tab), the host releases it: refused clients are
 * judged again, in the order they arrived, and the next config is served.
 * The next config must keep the `projectId`: the host's RTDB instances,
 * their data and rules belong to it, so another project is refused until the
 * host restarts.
 * Each refusal and each eviction is logged on the host.
 */
import { differenceDetail, sameBackend } from './backend-options.js';
import type { AppConfigMessage } from '../protocol.js';
import type { HostCtx, PortLike } from '../host-context.js';
import { resolvePendingDatabaseTargets } from './rules.js';
import { adoptAppDefaultRtdbInstance } from './rtdb-instances.js';

export function configConflictError(
  expected?: Record<string, unknown>,
  actual?: Record<string, unknown>,
): Error & { code: string } {
  return Object.assign(
    new Error(`Pyric currently supports one Firebase configuration per runtime${differenceDetail(expected, actual)}`),
    { code: 'app/multiple-configs-not-supported' },
  );
}

interface Sender {
  fromPriorHost: boolean;
  hostVerified: boolean;
}

function senderOf(msg: AppConfigMessage): Sender {
  const fromPriorHost = msg.fromPriorHost === true;
  return { fromPriorHost, hostVerified: msg.hostVerified === true && !fromPriorHost };
}

/** Defaults derived from a provisional config are re-derived once a fresh one replaces it. */
function marksDefaultsProvisional(ctx: HostCtx): void {
  ctx.defaultRtdbAdoptedFromPriorHost = ctx.defaultRtdbInstance === undefined
    || ctx.defaultRtdbInstance === '__unnamed_default__';
}

/** How long the config outlives its last client: a reloading tab reattaches within it. */
const CONFIG_RELEASE_GRACE_MS = 5_000;

function holdsConfig(ctx: HostCtx, port: PortLike): void {
  (ctx.configHolderPorts ??= new Set()).add(port);
  clearTimeout(ctx.configReleaseTimer);
  ctx.configReleaseTimer = undefined;
}

function lockFirstConfig(ctx: HostCtx, port: PortLike, msg: AppConfigMessage, sender: Sender): void {
  ctx.appOptions = structuredClone(msg.options);
  holdsConfig(ctx, port);
  ctx.appOptionsFromPriorHost = sender.fromPriorHost;
  ctx.appOptionsVerified = sender.hostVerified;
  if (sender.fromPriorHost) {
    (ctx.priorHostConfigPorts ??= new Set()).add(port);
    marksDefaultsProvisional(ctx);
  } else if (!sender.hostVerified) {
    (ctx.unverifiedConfigPorts ??= new Set()).add(port);
    marksDefaultsProvisional(ctx);
  }
  adoptAppDefaultRtdbInstance(ctx);
  resolvePendingDatabaseTargets(ctx);
}

function supersedesLock(ctx: HostCtx, sender: Sender): boolean {
  const replacesPriorHost = ctx.appOptionsFromPriorHost === true && !sender.fromPriorHost;
  const verifiesUnverified = ctx.appOptionsVerified !== true && sender.hostVerified;
  return replacesPriorHost || verifiesUnverified;
}

function rejectPort(ctx: HostCtx, port: PortLike, options: Record<string, unknown>): void {
  (ctx.rejectedConfigPorts ??= new WeakSet()).add(port);
  (ctx.rejectedConfigDetails ??= new WeakMap()).set(port, options);
}

function evictPort(
  ctx: HostCtx,
  port: PortLike,
  priorOptions: Record<string, unknown>,
  conflict: Error & { code: string },
  cleanupPort: (port: PortLike) => void,
): void {
  const subs = ctx.subs.get(port);
  if (subs !== undefined) {
    for (const subId of subs.keys()) {
      port.postMessage({ t: 'snap', subId, value: { __error: { code: conflict.code, message: conflict.message } } });
    }
  }
  cleanupPort(port);
  ctx.disconnectedPorts?.delete(port);
  rejectPort(ctx, port, priorOptions);
}

function logEviction(detail: string, sender: Sender, evicted: number): void {
  const isNoneEvicted = evicted === 0;
  if (isNoneEvicted) return;
  const who = sender.hostVerified ? 'a client verified against this host' : 'a client of this host boot';
  const clients = evicted === 1 ? '1 client' : `${evicted} clients`;
  console.warn(
    `[pyric] Replaced the provisional Firebase config with the one ${who} sent${detail}. ` +
      `${clients} on the earlier config, from a cached Service Worker or an earlier host, now get app/multiple-configs-not-supported.`,
  );
}

/** Refused clients whose config the new lock shares join it, as if they had arrived now. */
function readmitRefusedPorts(ctx: HostCtx): void {
  const refused = ctx.refusedConfigMessages;
  if (refused === undefined) return;
  for (const [port, msg] of refused) {
    const sharesNewConfig = sameBackend(ctx.appOptions, msg.options);
    if (!sharesNewConfig) continue;
    refused.delete(port);
    ctx.rejectedConfigPorts?.delete(port);
    ctx.rejectedConfigDetails?.delete(port);
    joinLockedConfig(ctx, port, msg, senderOf(msg));
  }
}

function supersedeLock(
  ctx: HostCtx,
  port: PortLike,
  msg: AppConfigMessage,
  sender: Sender,
  cleanupPort: (port: PortLike) => void,
): void {
  const priorOptions = ctx.appOptions!;
  const priorPorts = [
    ...(ctx.priorHostConfigPorts ?? []),
    ...(sender.hostVerified ? (ctx.unverifiedConfigPorts ?? []) : []),
  ];
  ctx.appOptionsFromPriorHost = false;
  ctx.appOptionsVerified = sender.hostVerified;
  // Held before any eviction, so evicting the old holders never releases the config.
  holdsConfig(ctx, port);
  ctx.priorHostConfigPorts?.clear();
  if (sender.hostVerified) {
    ctx.unverifiedConfigPorts?.clear();
  } else {
    (ctx.unverifiedConfigPorts ??= new Set()).add(port);
  }
  const keepsConfig = sameBackend(priorOptions, msg.options);
  if (keepsConfig) {
    ctx.defaultRtdbAdoptedFromPriorHost = false;
    return;
  }
  ctx.appOptions = structuredClone(msg.options);
  if (ctx.defaultRtdbAdoptedFromPriorHost) {
    ctx.defaultRtdbInstance = undefined;
    ctx.defaultRtdbAdoptedFromPriorHost = false;
  }
  adoptAppDefaultRtdbInstance(ctx);
  resolvePendingDatabaseTargets(ctx);
  const conflict = configConflictError(ctx.appOptions, priorOptions);
  const evicted = priorPorts.filter(stalePort => stalePort !== port);
  for (const stalePort of evicted) evictPort(ctx, stalePort, priorOptions, conflict, cleanupPort);
  logEviction(differenceDetail(ctx.appOptions, priorOptions), sender, evicted.length);
  readmitRefusedPorts(ctx);
}

function joinLockedConfig(ctx: HostCtx, port: PortLike, msg: AppConfigMessage, sender: Sender): void {
  const conflicts = !sameBackend(ctx.appOptions, msg.options);
  if (conflicts) {
    rejectPort(ctx, port, structuredClone(msg.options));
    (ctx.refusedConfigMessages ??= new Map()).set(port, structuredClone(msg));
    console.warn(
      `[pyric] Refused a client's Firebase config${differenceDetail(ctx.appOptions, msg.options)}. ` +
        'This host serves one config, the one another client sent first, and that client keeps working. ' +
        'Every call from the refused client gets app/multiple-configs-not-supported. ' +
        'Give the page and every server process the same projectId, databaseURL and storageBucket, then reload the refused client.',
    );
    return;
  }
  holdsConfig(ctx, port);
  const joinsPriorHostLock = ctx.appOptionsFromPriorHost === true && sender.fromPriorHost;
  const joinsUnverifiedLock = ctx.appOptionsVerified !== true && !sender.hostVerified;
  if (joinsPriorHostLock) {
    ctx.priorHostConfigPorts?.add(port);
  } else if (joinsUnverifiedLock) {
    (ctx.unverifiedConfigPorts ??= new Set()).add(port);
  }
}

/** An app port's `appConfig`: lock the host's config, replace a provisional one, or join or refuse a held one. */
export function handleAppConfig(
  ctx: HostCtx,
  port: PortLike,
  msg: AppConfigMessage,
  cleanupPort: (port: PortLike) => void,
): void {
  const sender = senderOf(msg);
  // A refused port that sends its config again (a reconnect) is judged on it anew.
  const wasRefusedOnArrival = ctx.refusedConfigMessages?.delete(port) === true;
  if (wasRefusedOnArrival) {
    ctx.rejectedConfigPorts?.delete(port);
    ctx.rejectedConfigDetails?.delete(port);
  }
  const hasNoConfig = ctx.appOptions === undefined;
  if (hasNoConfig && changesProject(ctx, msg)) {
    refuseOtherProject(ctx, port, msg);
  } else if (hasNoConfig) {
    lockFirstConfig(ctx, port, msg, sender);
  } else if (supersedesLock(ctx, sender)) {
    supersedeLock(ctx, port, msg, sender, cleanupPort);
  } else {
    joinLockedConfig(ctx, port, msg, sender);
  }
}

/** No connected client uses the config: serve the next one, judging refused clients again in arrival order. */
function releaseConfig(ctx: HostCtx, cleanupPort: (port: PortLike) => void): void {
  ctx.releasedAppOptions = ctx.appOptions;
  ctx.appOptions = undefined;
  ctx.appOptionsFromPriorHost = undefined;
  ctx.appOptionsVerified = undefined;
  ctx.priorHostConfigPorts?.clear();
  ctx.unverifiedConfigPorts?.clear();
  ctx.defaultRtdbAdoptedFromPriorHost = false;
  const refused = [...(ctx.refusedConfigMessages ?? [])];
  ctx.refusedConfigMessages?.clear();
  for (const [port, msg] of refused) {
    ctx.rejectedConfigPorts?.delete(port);
    ctx.rejectedConfigDetails?.delete(port);
    handleAppConfig(ctx, port, msg, cleanupPort);
  }
}

/** A port that is gone holds no place in the config lock; the last one to hold the config releases it. */
export function forgetConfigPort(ctx: HostCtx, port: PortLike, cleanupPort: (port: PortLike) => void): void {
  ctx.priorHostConfigPorts?.delete(port);
  ctx.unverifiedConfigPorts?.delete(port);
  ctx.refusedConfigMessages?.delete(port);
  const holders = ctx.configHolderPorts;
  const heldConfig = holders?.delete(port) === true;
  const wasLastHolder = heldConfig && holders.size === 0 && ctx.appOptions !== undefined;
  if (wasLastHolder) scheduleRelease(ctx, cleanupPort);
}

/** Release after the grace unless a client with the config attaches first (`holdsConfig` cancels it). */
function scheduleRelease(ctx: HostCtx, cleanupPort: (port: PortLike) => void): void {
  clearTimeout(ctx.configReleaseTimer);
  const timer = setTimeout(() => {
    ctx.configReleaseTimer = undefined;
    const isStillUnheld = (ctx.configHolderPorts?.size ?? 0) === 0 && ctx.appOptions !== undefined;
    if (isStillUnheld) releaseConfig(ctx, cleanupPort);
  }, ctx.configReleaseGraceMs ?? CONFIG_RELEASE_GRACE_MS);
  // A Node host does not stay up for a pending release.
  (timer as { unref?: () => void }).unref?.();
  ctx.configReleaseTimer = timer;
}

/** The config refusals are judged against: the one served, else the one last released. */
export function refusalBaseline(ctx: HostCtx): Record<string, unknown> | undefined {
  return ctx.appOptions ?? ctx.releasedAppOptions;
}

/** After a release, a config for another project is refused: the host's RTDB data and rules are the first project's. */
function changesProject(ctx: HostCtx, msg: AppConfigMessage): boolean {
  const released = ctx.releasedAppOptions;
  if (released === undefined) return false;
  return !sameBackend({ projectId: released.projectId }, { projectId: msg.options.projectId });
}

function refuseOtherProject(ctx: HostCtx, port: PortLike, msg: AppConfigMessage): void {
  rejectPort(ctx, port, structuredClone(msg.options));
  (ctx.refusedConfigMessages ??= new Map()).set(port, structuredClone(msg));
  console.warn(
    `[pyric] Refused a client's Firebase config${differenceDetail(ctx.releasedAppOptions, msg.options)}. ` +
      "The clients on this host's earlier config have disconnected, but its Realtime Database data and rules belong to that project. " +
      'Every call from the refused client gets app/multiple-configs-not-supported. Restart the host to serve another projectId.',
  );
}
