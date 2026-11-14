import { createDenialThrottle, noteAiDiagnostic } from '../namespace.js';
import { aiDiagnosticPayloadFor } from '../ai-diagnostics-relay.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createStorageByteRoute } from './storage-byte-route.js';
import {
  defaultBucketNames, finishUploadSession, openUploadSession, seedDefaultBucketNames,
  storeBucketOf, uploadSessionOf, uploadTokenOf,
} from '../worker/host/storage.js';
import type { ServeLogger } from '../server.js';
import { fetchAiUpstream, resolveAiProxyUpstream } from '../ai-proxy.js';
import {
  databaseInstanceRulesHost,
  deployFirestoreRulesToHost,
  enforcedFirestoreRulesState,
  resetHostSandbox,
  normalizeDatabaseRules,
  setDatabaseRules,
  setDatabaseTargetRules,
} from '../worker/host/rules.js';
import { SERVE_HISTORY_LIMITS } from '../observation-limits.js';
import { randomUUID } from 'node:crypto';
import { createOperationBudget } from '../../bridge/operation-budget.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSandboxRoot, emitSandboxEvent, getInternalEnv, LOCKED_DATABASE_RULES, makeSandboxRuntimeErrorEvent } from 'pyric/sandbox/internal';
import { getFirestore } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { getActiveRules as getActiveDatabaseRules } from 'pyric/sandbox/database';
import { heldDatabaseInstances } from 'pyric/database/internal';
import { sandbox as rtdbSandbox } from 'pyric/database';
import { sandbox as authSandbox } from 'pyric/auth';
import { FirebaseError } from 'pyric/app';
import { DEFAULT_BUCKET, installStorageBackend } from 'pyric/storage/internal';
import { applyStorageRulesUpdate, storageRulesUpdateFor } from '../storage-rules-install.js';
import {
  assertJsonSafeRelayValue,
  FUNCTIONS_RTDB_CHILD_DEVICE_LABEL,
  MAX_MOUNTED_MCP_SESSIONS,
  type BridgeMessage,
  type ToolCallRequest,
  type WorkerResFrame,
} from '../../bridge/protocol.js';
import { dispatchSandboxTool, SANDBOX_TOOL_NAMES } from '../../bridge/client/dispatch.js';
import { sandboxToolEffect } from '../../bridge/tool-families.js';
import { createSurfaceContext } from '../../bridge/surface/context.js';
import { accountLookupFor } from '../../bridge/surface/app-session.js';
import { CALLER_IDENTITY_ARG, SurfaceIdentity, type IdentityInput } from '../../bridge/surface/identity.js';
import { resolveStoredUidIdentity } from '../../bridge/surface/stored-identity.js';
import { callMethod } from '../../bridge/surface/method-call.js';
import { methodByKey } from '../../bridge/surface/methods/registry.js';
import type { OperationResult, SurfaceContext } from '../../bridge/surface/types.js';
import type { InitPayload, RulesDestination } from '../init-payload.js';
import { applyServeInit } from '../worker/serve-init.js';
import { cleanupPortWithDisconnect, handleMessage, type HostCtx, type PortLike } from '../worker/host.js';
import { ensureAuth, setPortSession } from '../worker/host-auth.js';
import { callerFor, markPortConnection, portClientId, SERVICE_WORKER_TAB_ID, setPortTabId, type PortConnection } from '../worker/host/caller.js';
import { restoreFirestoreSubscriptions } from '../worker/host/subscriptions.js';
import { drainPortRtdbDisconnects } from '../worker/host/rtdb.js';
import { observedPortInterrupted, observedPortResumed } from '../worker/host/observe.js';
import { hostDatabaseInstances } from '../worker/host/rtdb-instance-catalog.js';
import { rtdbInstance } from '../worker/host/rtdb-instances.js';
import { isPathInside } from '../path-inside.js';
import type { LiveSeedMode, ObservedSessionDataSnapshot } from '../observed-session/wire.js';
import type { ObservedSessionDataStore } from '../observed-session/store.js';
import { createObservedSeedRunner, type ObservedSeedResult } from './seed-from-observed-session.js';
import { serializeError, type InboundMessage, type OutboundMessage } from '../worker/protocol.js';
import { createHostedPersistence, formatStorageRepairs, HOSTED_NAMESPACE, hostedStateDirectory, type HostedPersistence } from './persistence.js';
import { requiresHealthyPersistence } from './persistence-admission.js';
import { refuseOwnWrite, type PyricWriteRefusal } from './own-writes.js';
import { MAX_HOSTED_METHOD_OWNERS, type HostedMethodRequest } from './method-protocol.js';
import { createReproRecorder, type ReproRecorder } from '../repro/recorder.js';
import { buildReproFile, captureReproBase } from '../repro/capture.js';
import type { ReproFile } from '../repro/format.js';

type HostedTransport = 'worker-port' | 'worker-relay';

/** What a socket carries, for the caller its events name: a relay, a server process using the client SDK, or a page. */
function portConnection(transport: HostedTransport, platform: string | undefined): PortConnection {
  if (transport === 'worker-relay') return 'relay';
  return platform === 'node' ? 'node' : 'page';
}

interface OperationQueue {
  pending: Promise<void>;
  budget: ReturnType<typeof createOperationBudget>;
}

interface HostedPort extends OperationQueue {
  port: PortLike;
  transport: HostedTransport;
}

function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Server-owned persistence, live-mode, and AI configuration; never sent to browsers. */
export interface HostedRuntimeOptions {
  /** Borrowed from the session; the session closes it after the runtime drains. */
  persistence?: HostedPersistence;
  proxyUpstream?: string;
  logger?: ServeLogger;
  /** Keep the bounded operation log a repro file is written from. Defaults to true. */
  record?: boolean;
  /** Entries one repro log window holds; see `createReproRecorder`. */
  reproWindow?: number;
  /**
   * Live mode's refusal of pyric's own writes (`own-writes.ts`). With it, the
   * host refuses every write it is asked for, from a connection, an MCP tool
   * or a direct command, before it runs. Absent outside live mode.
   */
  ownWriteRefusal?: PyricWriteRefusal;
  /** Live mode's host-memory observed session store for local rules evaluation. */
  observedSession?: ObservedSessionDataStore;
  /** Require `x-pyric-session-token` on SDK Storage byte-route reads. */
  requireSessionToken?: boolean;
}

/** The write a port's frame asks for: a durable operation or a write tool, named for the refusal. Null for anything else. */
function portWriteOf(message: InboundMessage): string | null {
  if (message.t === 'op') return requiresHealthyPersistence(message) ? message.method : null;
  if (message.t === 'tool') return sandboxToolEffect(message.name) === 'write' ? message.name : null;
  return null;
}

/** One Node-owned sandbox; each admitted consumer owns its ordered work. */
export async function createHostedRuntime(
  payload: InitPayload,
  baseUrl: string | (() => string),
  send: (message: BridgeMessage) => void,
  projectDir: string,
  ai: HostedRuntimeOptions = {},
) {
  const ownedProjectDir = realpathSync(projectDir);
  /** Whether a caller's project directory is this host's project or inside it. */
  const isInOwnedProject = (callerProjectDir: string): boolean =>
    isPathInside(ownedProjectDir, resolveRealPath(callerProjectDir));
  const ownsPersistence = ai.persistence === undefined;
  const persistence = ai.persistence ?? await createHostedPersistence(ownedProjectDir);
  // The session prints the repairs it opened; this path prints its own.
  const reportsRepairs = ai.persistence === undefined;
  if (reportsRepairs) for (const line of formatStorageRepairs(persistence.repairedObjects)) ai.logger?.note(line);
  const closeOwnedPersistence = () => {
    if (ownsPersistence) persistence.close();
  };
  const sandbox = createSandboxRoot(SERVE_HISTORY_LIMITS);
  const instanceId = randomUUID();
  try {
    installStorageBackend(sandbox, persistence.storage);
    await sandbox.enablePersistence({ key: HOSTED_NAMESPACE, injectedBackend: persistence.backend });
  } catch (error) {
    sandbox.dispose();
    closeOwnedPersistence();
    throw error;
  }
  const persistenceIsHealthy = () => persistence.status().state === 'healthy';
  const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
  let persistenceWork = Promise.resolve();
  let queuedFlush: Promise<void> | null = null;
  function flushPersistence(): Promise<void> {
    if (queuedFlush !== null) return queuedFlush;
    // An older asynchronous snapshot must finish before the next one starts;
    // yielding one I/O turn coalesces concurrent callers into one commit.
    const flushed = persistenceWork.then(nextTurn).then(() => {
      queuedFlush = null;
      return persistState();
    });
    queuedFlush = flushed;
    // The requesting caller receives failures; later accepted work still drains.
    persistenceWork = flushed.catch(() => {});
    return flushed;
  }
  async function persistState(): Promise<void> {
    try {
      await sandbox.flush();
    } catch (error) {
      persistence.markUnhealthy();
      console.error('[pyric hosted] persistence failed:', error);
      throw new FirebaseError('committed-but-not-durable',
        'The mutation committed in memory but could not be persisted. Do not repeat it; restore persistence before further mutations.');
    }
  }
  function requireHealthyPersistence(): void {
    const healthy = persistenceIsHealthy();
    if (healthy) return;
    throw new FirebaseError('persistence-unhealthy',
      'The mutation was not executed because hosted persistence is unhealthy. Reads reflect in-memory state. Restore persistence and restart the host before further mutations.');
  }

  function describeRead(result: OperationResult): OperationResult {
    const readsUnhealthyMemory = result.ok && !persistenceIsHealthy();
    if (readsUnhealthyMemory) {
      const summary = `${result.summary} Hosted persistence is unhealthy; this read reflects in-memory state.`;
      return { ...result, summary };
    }
    return result;
  }

  async function persistMutationResult(result: OperationResult): Promise<OperationResult> {
    // A mutation may return partial success with ok:false, so still flush its changes.
    try {
      await flushPersistence();
    } catch (error) {
      const succeeded = result.ok;
      if (succeeded) throw error;
      const summary = `${result.summary}\nPersistence also failed; some changes may exist only in memory. Inspect host state before retrying.`;
      return { ...result, summary };
    }
    return result;
  }
  const aiThrottle = createDenialThrottle();
  const aiFetch: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      fetchAiUpstream(input, init, aiThrottle, ai.logger, 'ai-upstream'),
    { preconnect: fetch.preconnect },
  );
  const defaultBucketsPath = join(hostedStateDirectory(ownedProjectDir), 'default-buckets.json');
  function loadPersistedDefaultBuckets(): string[] {
    if (!existsSync(defaultBucketsPath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(defaultBucketsPath, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item !== '') : [];
    } catch {
      return [];
    }
  }
  function savePersistedDefaultBuckets(): void {
    try {
      mkdirSync(hostedStateDirectory(ownedProjectDir), { recursive: true });
      const tmp = `${defaultBucketsPath}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify([...defaultBucketNames(ctx)].sort()));
      renameSync(tmp, defaultBucketsPath);
    } catch {
      // Best-effort alias hint; does not affect object durability.
    }
  }

  const ctx: HostCtx = {
    sandbox,
    flushPersistence,
    onDefaultBucketName: () => {
      savePersistedDefaultBuckets();
    },
    db: getFirestore(sandbox),
    instanceId,
    subs: new Map(),
    checkpointBackend: persistence.checkpoints,
    sessionMode: 'NONE',
    aiEngine: payload.ai?.engine,
    aiUpstream: { baseUrl: resolveAiProxyUpstream(ai.proxyUpstream).target, fetch: aiFetch },
    storageByteRoute: true,
    observedSession: ai.observedSession,
  };
  seedDefaultBucketNames(ctx, loadPersistedDefaultBuckets());
  const hostedFetch: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const isRelativeUrl = typeof input === 'string';
      // Vite assigns its listening origin after the sandbox is initialised.
      const dynamicOrigin = typeof baseUrl === 'function';
      let origin: string;
      if (dynamicOrigin) origin = baseUrl();
      else origin = baseUrl;
      const request = isRelativeUrl ? new URL(input, origin) : input;
      return fetch(request, init);
    },
    { preconnect: fetch.preconnect },
  );
  let initialized: ReturnType<typeof applyServeInit>;
  try {
    initialized = applyServeInit(ctx, payload, { fetch: hostedFetch });
  } catch (error) {
    sandbox.dispose();
    closeOwnedPersistence();
    throw error;
  }
  // The broker runs in this process, so no page relays its diagnostics to the
  // denials route. Print them here through the same formatter and throttle.
  const aiDiagnosticsThrottle = createDenialThrottle();
  const unsubscribeAiDiagnostics = sandbox.onEvent((event) => {
    const diagnostic = aiDiagnosticPayloadFor(event);
    if (diagnostic !== null) noteAiDiagnostic(aiDiagnosticsThrottle, ai.logger, diagnostic);
  });
  const unsubscribeFailure = persistence.onFailure(() => {
    emitSandboxEvent(sandbox, makeSandboxRuntimeErrorEvent({
      at: Date.now(), service: 'runtime', method: 'persist', auth: null,
      error: { code: 'persistence-unhealthy', message: 'Hosted persistence failed. Mutations are blocked; reads may include unsaved changes. Repair the store and restart the host.' },
    }));
  });
  const surfaceContext = createSurfaceContext(sandbox, ownedProjectDir, undefined, persistence.checkpoints);
  // A `database` method's `instance` resolves as a client's does on this host.
  const hostInstances = hostDatabaseInstances(ctx);
  surfaceContext.databaseInstances = async () => hostInstances;
  // Storage rules simulation binds the default bucket under the app's name for it.
  surfaceContext.storageBucketName = () => {
    const named = ctx.appOptions?.storageBucket;
    return typeof named === 'string' ? named : undefined;
  };
  surfaceContext.functionsHost = {
    serveUrl: () => (typeof baseUrl === 'function' ? baseUrl() : baseUrl),
    instanceId,
    ...(payload.sessionToken !== undefined ? { sessionToken: payload.sessionToken } : {}),
  };
  const ports = new Map<string, HostedPort>();
  const uploadPartCounts = new Map<string, number>();
  const recordedUploadFiles = new Map<string, string>();
  const recordedUploadsDir = ai.record === false ? undefined : mkdtempSync(join(tmpdir(), 'pyric-repro-uploads-'));
  const recorder: ReproRecorder | undefined = ai.record === false ? undefined : createReproRecorder({
    limit: ai.reproWindow,
    capture: () => captureReproBase(ctx, [...ports].map(([id, owned]) => [id, owned.port] as [string, PortLike])),
    onDrop(dropped, retained) {
      const retainedIds = new Set<string>();
      for (const entry of retained) {
        if (entry.kind === 'upload-slice' || entry.kind === 'upload') retainedIds.add(entry.uploadId);
      }
      for (const entry of dropped) {
        if (entry.kind !== 'upload-slice' && entry.kind !== 'upload') continue;
        if (retainedIds.has(entry.uploadId)) continue;
        const filePath = recordedUploadFiles.get(entry.uploadId);
        recordedUploadFiles.delete(entry.uploadId);
        uploadPartCounts.delete(entry.uploadId);
        if (filePath !== undefined) rmSync(filePath, { force: true });
      }
    },
  });
  // A replay host has no deploy targets, so the log names the instances a
  // target's rules reach.
  if (recorder !== undefined) {
    ctx.onDatabaseTargetDeploy = ({ instance, rules }) => {
      recorder.note({ kind: 'rules', at: Date.now(), service: 'database', instance, source: rules });
    };
  }
  const closingPorts = new Set<Promise<void>>();
  const backgroundFunctionsSessions = new Set<string>();
  const suppressedRelaySnapshotCounts = new Map<string, number>();
  const methodWork = new Map<object, OperationQueue>();
  const toolWork = new Map<string, OperationQueue>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const seedRunner = createObservedSeedRunner({
    ctx,
    ownedProjectDir,
    isClosed: () => closed,
    isInOwnedProject,
    requireHealthyPersistence,
    restoreFirestoreSubscriptions,
    flushPersistence,
  });

  /** The log records an MCP caller's tool calls as a port of its own. */
  function toolSession(message: ToolCallRequest): string {
    return `mcp:${message.callerId ?? 'legacy'}`;
  }

  function reconcilePortSessions(): void {
    if (!ctx.portSessions || ctx.portSessions.size === 0) return;
    const knownUids = new Set(authSandbox.listUsers(ensureAuth(ctx)).map(user => user.uid));
    for (const [port, session] of [...ctx.portSessions.entries()]) {
      if (session !== null && !knownUids.has(session.user.uid)) {
        setPortSession(ctx, port, null);
        ctx.portSessions.delete(port);
      }
    }
  }

  /** The Firestore status from the rules the sandbox enforces, never `active` for a source production would not load. */
  function syncFirestoreActiveRulesFromSandbox(): void {
    const source = getInternalEnv(ctx.sandbox).getRules();
    ctx.activeRules ??= {};
    ctx.activeRules.firestore = enforcedFirestoreRulesState(source, ctx.activeRules.firestore);
  }

  /** Synchronize the default RTDB instance's tracked active rules from the sandbox, and re-apply named instance rules after checkpoint restore or branch promote. */
  function syncDatabaseActiveRulesFromSandbox(reapplyNamedInstances = false): void {
    const defaultRtdb = rtdbInstance(ctx);
    const active = getActiveDatabaseRules(defaultRtdb.live);
    if (active !== null) {
      defaultRtdb.rules = {
        source: structuredClone(active),
        lastKnownGood: structuredClone(active),
        updatedAt: Date.now(),
        status: 'active',
        messages: [],
      };
    } else {
      delete defaultRtdb.rules;
    }
    if (reapplyNamedInstances) {
      for (const heldName of heldDatabaseInstances(ctx.sandbox)) {
        rtdbInstance(ctx, heldName);
      }
      for (const [, instance] of ctx.rtdbInstances?.entries() ?? []) {
        if (instance.selector === undefined) continue;
        const activeNamed = getActiveDatabaseRules(instance.live);
        if (activeNamed !== null) {
          instance.rules = {
            source: structuredClone(activeNamed),
            lastKnownGood: structuredClone(activeNamed),
            updatedAt: Date.now(),
            status: 'active',
            messages: [],
          };
        } else {
          delete instance.rules;
          const policy = ctx.rtdbDefaultPolicy ?? 'deny';
          rtdbSandbox.setDefaultPolicy(instance.live, policy);
          rtdbSandbox.setRules(instance.live, policy === 'allow' ? null : LOCKED_DATABASE_RULES);
        }
      }
    }
  }

  async function handleToolCall(message: ToolCallRequest): Promise<void> {
    await recorder?.inbound(toolSession(message), {
      t: 'tool', id: message.id, name: message.name, args: message.args ?? {},
      ...(message.actAs ? { actAs: message.actAs } : {}),
    });
    try {
      const effect = sandboxToolEffect(message.name);
      const changesState = effect === 'write';
      if (changesState) refuseOwnWrite(ai.ownWriteRefusal, { action: message.name, writer: 'mcp' });
      if (changesState) requireHealthyPersistence();
      // The window names the call's synchronous events; the tool's Firestore
      // handles name the rest (`bridge/client/dispatch.ts`).
      const dispatch = () => dispatchSandboxTool(sandbox, message.name, message.args, message.actAs);
      let result = await (sandbox.runWithProvenance
        ? sandbox.runWithProvenance({ caller: { kind: 'mcp' } }, dispatch)
        : dispatch());
      if (result.ok) {
        if (message.name === 'firestore_simulator_create') {
          syncFirestoreActiveRulesFromSandbox();
          restoreFirestoreSubscriptions(ctx);
        }
        // Deleting or disabling a user leaves its signed-in ports alone, as
        // production leaves a client signed in: the next token refresh is
        // refused and signs the port out (#1950).
      }
      if (changesState) result = await persistMutationResult(result);
      const isRead = effect === 'read';
      if (isRead) result = describeRead(result);
      send({ type: 'tool-result', id: message.id, ok: true, result });
      recorder?.outbound(toolSession(message), { t: 'res', id: message.id, ok: true, value: result });
    } catch (error) {
      const serialized = serializeError(error);
      send({ type: 'tool-result', id: message.id, ok: false, error: serialized });
      recorder?.outbound(toolSession(message), { t: 'res', id: message.id, ok: false, error: serialized });
    }
  }

  function enqueueToolCall(message: ToolCallRequest): void {
    const callerId = message.callerId ?? 'legacy';
    const existing = toolWork.get(callerId);
    const needsQueue = existing === undefined;
    const isAtSessionCapacity = needsQueue && toolWork.size >= MAX_MOUNTED_MCP_SESSIONS;
    if (isAtSessionCapacity) {
      send({ type: 'tool-result', id: message.id, ok: false, error: {
        code: 'resource-exhausted',
        message: `The hosted sandbox is at its MCP execution session cap (${MAX_MOUNTED_MCP_SESSIONS}).`,
      } });
      return;
    }
    const owned = existing ?? { pending: Promise.resolve(), budget: createOperationBudget() };
    const reservation = owned.budget.reserve(message);
    const isRefused = !reservation.accepted;
    if (isRefused) {
      send({ type: 'tool-result', id: message.id, ok: false, error: reservation.error });
      return;
    }
    const pending = owned.pending.then(() => handleToolCall(message)).catch((error: unknown) => {
      console.error('[pyric hosted] tool result delivery failed:', error);
    }).finally(reservation.release);
    owned.pending = pending;
    toolWork.set(callerId, owned);
    void pending.then(() => {
      const isLastCall = owned.pending === pending;
      if (isLastCall) toolWork.delete(callerId);
    });
  }

  function relayMessage(clientSessionId: string, message: OutboundMessage): void {
    const isResponse = message.t === 'res';
    if (isResponse) {
      const response: WorkerResFrame = { type: 'worker-res', id: message.id, clientSessionId, ok: message.ok };
      const succeeded = message.ok;
      if (succeeded) {
        assertJsonSafeRelayValue('hosted operation', message.value);
        response.value = message.value;
      } else {
        response.error = message.error;
      }
      send(response);
    }
    const isSnapshot = message.t === 'snap';
    if (isSnapshot) {
      if ((suppressedRelaySnapshotCounts.get(clientSessionId) ?? 0) > 0) return;
      let value = message.value;
      try {
        assertJsonSafeRelayValue('hosted subscription', value);
      } catch (error) {
        value = { __error: serializeError(error) };
      }
      send({ type: 'worker-snap', clientSessionId, subId: message.subId, value });
    }
  }

  function deliverOutbound(clientSessionId: string, message: OutboundMessage, transport: HostedTransport): void {
    recorder?.outbound(clientSessionId, message);
    const usesWorkerRelay = transport === 'worker-relay';
    if (usesWorkerRelay) relayMessage(clientSessionId, message);
    else send({ type: 'worker-message-result', clientSessionId, message });
  }

  function portFor(clientSessionId: string, transport: HostedTransport): HostedPort {
    const existing = ports.get(clientSessionId);
    const hasExistingPort = existing !== undefined;
    if (hasExistingPort) return existing;
    const owned: HostedPort = {
      port: {
        postMessage(message) {
          deliverOutbound(clientSessionId, message, owned.transport);
        },
      },
      transport,
      pending: Promise.resolve(),
      budget: createOperationBudget(),
    };
    ports.set(clientSessionId, owned);
    return owned;
  }

  /** In live mode, refuses a port's write with the caller its events would name. */
  function refusePortWrite(port: PortLike, message: InboundMessage): void {
    const refusal = ai.ownWriteRefusal;
    if (refusal === undefined) return;
    const action = portWriteOf(message);
    if (action === null) return;
    refuseOwnWrite(refusal, { action, writer: callerFor(ctx, port, message).kind });
  }

  function enqueue(clientSessionId: string, incoming: InboundMessage, transport: HostedTransport, platform?: string): void {
    const owned = portFor(clientSessionId, transport);
    markPortConnection(ctx, owned.port, portConnection(transport, platform));
    // A service worker names its realm at attach, so a connection that sends no `appConfig` reads as one too.
    const isServiceWorker = transport === 'worker-port' && platform === SERVICE_WORKER_TAB_ID;
    if (isServiceWorker) setPortTabId(ctx, owned.port, SERVICE_WORKER_TAB_ID);
    let releaseOperation: (() => void) | undefined;
    // An observed call or unobserved lists are charged like an operation, so a client cannot queue them without bound.
    const isOperation = incoming.t === 'op' || incoming.t === 'tool' || incoming.t === 'observe' || incoming.t === 'unobserved';
    if (isOperation) {
      const reservation = owned.budget.reserve(incoming);
      const isRefused = !reservation.accepted;
      if (isRefused) {
        deliverOutbound(clientSessionId, { t: 'res', id: incoming.id, ok: false, error: reservation.error }, transport);
        return;
      }
      releaseOperation = reservation.release;
    }
    // Admission owns identity. A payload cannot address another app's port.
    const message: InboundMessage = incoming.resumeSession === true
      ? { ...incoming, clientSessionId: undefined, resumeSession: true }
      : { ...incoming, clientSessionId: undefined, resumeSession: undefined };
    owned.pending = owned.pending.then(async () => {
      owned.transport = transport;
      if (message.resumeSession === true) {
        ctx.disconnectedPorts?.delete(owned.port);
        observedPortResumed(ctx, owned.port);
      }
      await recorder?.inbound(clientSessionId, message);
      refusePortWrite(owned.port, message);
      const changesDurableState = message.t === 'op' && requiresHealthyPersistence(message);
      if (changesDurableState) requireHealthyPersistence();
      return handleMessage(ctx, owned.port, message);
    }).catch((error: unknown) => {
      const hasReplyId = 'id' in message;
      if (hasReplyId) {
        owned.port.postMessage({ t: 'res', id: message.id, ok: false, error: serializeError(error) });
      }
      const isSubscription = message.t === 'sub';
      if (isSubscription) {
        owned.port.postMessage({ t: 'snap', subId: message.subId, value: { __error: serializeError(error) } });
      }
    }).finally(() => {
      releaseOperation?.();
    });
  }

  async function closePort(clientSessionId: string): Promise<void> {
    const owned = ports.get(clientSessionId);
    const isMissingPort = owned === undefined;
    if (isMissingPort) return;
    ports.delete(clientSessionId);
    const closing = owned.pending.then(() => {
      if (!closed) recorder?.note({ kind: 'client', at: Date.now(), session: clientSessionId, event: 'disconnect' });
      return cleanupPortWithDisconnect(ctx, owned.port);
    });
    closingPorts.add(closing);
    try {
      await closing;
    } finally {
      closingPorts.delete(closing);
    }
  }

  function interruptPort(clientSessionId: string): void {
    const owned = ports.get(clientSessionId);
    const isMissingPort = owned === undefined;
    if (isMissingPort) return;
    // A Node process whose next run already connected ends its listeners now.
    observedPortInterrupted(ctx, owned.port);
    owned.pending = owned.pending.then(() => {
      recorder?.note({ kind: 'client', at: Date.now(), session: clientSessionId, event: 'interrupted' });
      return drainPortRtdbDisconnects(ctx, owned.port);
    }).catch((error: unknown) => {
      console.error('[pyric hosted] RTDB disconnect cleanup failed:', error);
    });
  }

  const storageBytes = createStorageByteRoute({
    storage: {
      objectFile: async (bucket, path) => {
        const direct = await persistence.storage.objectFile(bucket, path);
        if (direct !== undefined || bucket === DEFAULT_BUCKET) return direct;
        if (defaultBucketNames(ctx).size > 0 || ctx.appOptions?.storageBucket !== undefined) return undefined;
        return persistence.storage.objectFile(DEFAULT_BUCKET, path);
      },
      uploadProgress: uploadId => persistence.storage.uploadProgress(uploadId),
      async appendUpload(uploadId, offset, bytes) {
        const progress = await persistence.storage.appendUpload(uploadId, offset, bytes);
        if (recorder !== undefined && recordedUploadsDir !== undefined) {
          let filePath = recordedUploadFiles.get(uploadId);
          if (filePath === undefined) {
            filePath = join(recordedUploadsDir, `${randomUUID()}.bin`);
            recordedUploadFiles.set(uploadId, filePath);
          }
          const fh = await openFile(filePath, 'a');
          try {
            await fh.appendFile(bytes);
          } finally {
            await fh.close();
          }
          const partIndex = uploadPartCounts.get(uploadId) ?? 0;
          uploadPartCounts.set(uploadId, partIndex + 1);
          recorder.note({
            kind: 'upload-slice',
            at: Date.now(),
            uploadId,
            partIndex,
            offset,
            length: bytes.byteLength,
          });
        }
        return progress;
      },
    },
    sessionToken: payload.sessionToken,
    requireSessionToken: ai.requireSessionToken,
    uploadToken: uploadId => uploadTokenOf(ctx, uploadId),
    bucketOf: name => storeBucketOf(ctx, name),
    sessions: {
      get: sessionId => uploadSessionOf(ctx, sessionId),
      open: (sessionId, size) => openUploadSession(ctx, sessionId, size),
      finish: sessionId => finishUploadSession(ctx, sessionId),
    },
  });

  /** In live mode, the result that refuses a direct command's write; null otherwise. */
  function ownWriteRefusalOf(key: string): OperationResult | null {
    try {
      refuseOwnWrite(ai.ownWriteRefusal, { action: key, writer: 'command' });
      return null;
    } catch (error) {
      const serialized = serializeError(error);
      return { ok: false, summary: serialized.message, data: { code: serialized.code } };
    }
  }

  return {
    /** The HTTP byte route; resolves false for any other path. */
    storageHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      return storageBytes(req, res, url);
    },
    /** Whether a byte route request from `origin` is an upload session's, from the origin the session names. */
    storageAllowsOrigin(url: URL, origin: string | undefined): boolean {
      return storageBytes.allowsOrigin(url, origin);
    },
    /** A null database or Storage source clears the rules, so the default
     *  policy applies: RTDB's configured policy, and deny-all for Storage.
     *  `instance` names the RTDB instance a database ruleset deploys to, as
     *  {@link setDatabaseRules} takes it, absent for the default instance, or
     *  an unresolved deploy target, as {@link setDatabaseTargetRules} takes it. */
    async deployRules(service: 'firestore' | 'database' | 'storage', source: string | null, instance?: RulesDestination): Promise<void> {
      if (closed) throw new Error('The hosted sandbox is closed.');
      if (service === 'storage') {
        // A bucket by name gets its own rules, a pending deploy target its
        // buckets' once resolved, and without either the default bucket (#1313).
        const update = storageRulesUpdateFor(source, instance);
        await applyStorageRulesUpdate(ctx.sandbox, update);
        const isDefaultBucket = update.bucket === undefined && update.target === undefined;
        if (isDefaultBucket) recorder?.note({ kind: 'rules', at: Date.now(), service, source });
        return;
      }
      if (instance !== undefined && typeof instance === 'object' && 'bucket' in instance) {
        throw new Error(`A ${service} ruleset does not deploy to a Storage bucket.`);
      }
      if (service === 'database') {
        const deployed = typeof instance === 'object'
          ? setDatabaseTargetRules(ctx, instance.target, source)
          : setDatabaseRules(ctx, instance, source);
        if (!deployed.ok) throw new Error(deployed.messages.map((message) => message.text).join('; '));
        if (typeof instance !== 'object') {
          recorder?.note({ kind: 'rules', at: Date.now(), service, ...(instance === undefined ? {} : { instance }), source });
        }
        return;
      }
      if (source === null) throw new Error('Firestore rules source is required.');
      const previousFirestoreRules = ctx.activeRules?.firestore ? structuredClone(ctx.activeRules.firestore) : undefined;
      const deployed = deployFirestoreRulesToHost(ctx, source);
      if (!deployed.ok) {
        if (ctx.activeRules) {
          if (previousFirestoreRules === undefined) delete ctx.activeRules.firestore;
          else {
            ctx.activeRules.firestore = previousFirestoreRules;
            const previousSource = previousFirestoreRules.status === 'active'
              ? previousFirestoreRules.source
              : previousFirestoreRules.lastKnownGood;
            if (typeof previousSource === 'string') setRules(ctx.sandbox, previousSource);
          }
        }
        const errorMessages = deployed.messages.filter((m) => m.severity === 'error').map((m) => m.text).filter(Boolean);
        throw new Error(deployed.rejectionMessage ?? (errorMessages.length > 0 ? errorMessages.join('; ') : 'Invalid Firestore security rules.'));
      }
      recorder?.note({ kind: 'rules', at: Date.now(), service, source });
    },
    /**
     * The repro file for the operations recorded so far: the starting state,
     * rules, signed-in ports and open listeners, then every frame since.
     */
    async captureRepro(callerProjectDir: string = ownedProjectDir): Promise<ReproFile> {
      if (closed) throw new Error('The hosted sandbox is closed.');
      if (!isInOwnedProject(callerProjectDir)) throw new Error('The discovered host belongs to another project.');
      if (recorder === undefined) throw new Error('This host does not record operations.');
      const log = await recorder.log();
      return buildReproFile(
        log,
        sha256 => persistence.state.objectFile?.(sha256),
        async (uploadId, offset, length) => {
          const filePath = recordedUploadFiles.get(uploadId);
          if (filePath === undefined) {
            throw new Error(`The bytes of Storage upload '${uploadId}' are no longer on disk; the repro cannot carry them.`);
          }
          const fh = await openFile(filePath, 'r');
          try {
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await fh.read(buffer, 0, length, offset);
            return buffer.subarray(0, bytesRead);
          } finally {
            await fh.close();
          }
        },
      );
    },
    /** The client id the events of a connection's frames carry (`caller.ts`), or undefined for one that names none or has closed. */
    clientIdOf(clientSessionId: string): string | undefined {
      const owned = ports.get(clientSessionId);
      return owned === undefined ? undefined : portClientId(ctx, owned.port);
    },
    /** Clears tracked active Firestore rules metadata without changing enforced sandbox rules. */
    clearActiveFirestoreRules(): void {
      if (ctx.activeRules) delete ctx.activeRules.firestore;
    },
    /** The Node host's per-instance RTDB rules, as `connectDatabaseInstanceRules` applies them. */
    databaseRules: databaseInstanceRulesHost(ctx),
    instanceId,
    toolNames: SANDBOX_TOOL_NAMES,
    /**
     * Seeds the local sandbox from a Live mode session's observed data, once
     * the developer confirmed it (`seed-from-observed-session.ts`). Queued so
     * two seeds never interleave, and flushed to `.pyric/state/hosted` with
     * `.pyric/` git-ignored first.
     */
    seedFromObservedSession(
      snapshot: ObservedSessionDataSnapshot,
      options: { mode?: LiveSeedMode; callerProjectDir?: string } = {},
    ): Promise<ObservedSeedResult> {
      return seedRunner.run(snapshot, options);
    },
    /** The admitted transport connection owns command ordering; JSON cannot choose another caller. */
    runMethod(call: HostedMethodRequest, connection: object): Promise<OperationResult> {
      if (closed) return Promise.resolve({ ok: false, summary: 'The hosted sandbox is closed.' });
      const { key, args: rawArgs, projectDir: callerProjectDir } = call;
      if (!isInOwnedProject(callerProjectDir)) return Promise.resolve({ ok: false, summary: 'The discovered host belongs to another project.' });
      const hasCallerIdentity = Object.hasOwn(rawArgs, CALLER_IDENTITY_ARG);
      const callerIdentity = hasCallerIdentity
        ? (rawArgs[CALLER_IDENTITY_ARG] as IdentityInput | undefined)
        : undefined;
      let args = rawArgs;
      if (hasCallerIdentity) {
        const stripped = { ...rawArgs };
        delete stripped[CALLER_IDENTITY_ARG];
        args = stripped;
      }
      const method = methodByKey(key);
      const existing = methodWork.get(connection);
      const needsQueue = existing === undefined;
      const isAtConnectionCapacity = needsQueue && methodWork.size >= MAX_HOSTED_METHOD_OWNERS;
      if (isAtConnectionCapacity) {
        return Promise.resolve({ ok: false,
          summary: `The hosted sandbox is at its direct-command connection cap (${MAX_HOSTED_METHOD_OWNERS}).`,
        });
      }
      const owned = existing ?? { pending: Promise.resolve(), budget: createOperationBudget() };
      const reservation = owned.budget.reserve({ ...call, args });
      const isRefused = !reservation.accepted;
      if (isRefused) return Promise.resolve({ ok: false, summary: reservation.error.message });
      const result = owned.pending.then(async () => {
        const hasMutationEffect = method.effect === 'write' || method.effect === 'destructive';
        // Switching the held identity is a memory-only control, and local
        // Assurance methods write local campaign files rather than sandbox state.
        const changesHeldIdentity = method.operation === 'switch_auth_identity';
        const isLocalAssuranceArtifact = method.tool === 'assurance' && method.effect !== 'production';
        const changesDurableState = hasMutationEffect && !changesHeldIdentity && !isLocalAssuranceArtifact;
        // In live mode pyric reaches no production project and acts as no one
        // on its own: a production effect (storage.status, storage.provision,
        // assurance.testRulesHosted) and an identity switch are refused with
        // every sandbox write, while local Assurance tooling stays available.
        const reachesProduction = method.effect === 'production';
        const isPyricOwnAction = (hasMutationEffect && !isLocalAssuranceArtifact) || reachesProduction;
        const refusal = isPyricOwnAction ? ownWriteRefusalOf(key) : null;
        if (refusal !== null) return refusal;
        if (changesDurableState) requireHealthyPersistence();
        if (changesDurableState && key !== 'rules.set') {
          recorder?.note({ kind: 'external', at: Date.now(), source: 'command', name: key });
        }
        let callContext: SurfaceContext = surfaceContext;
        if (callerIdentity !== undefined && typeof callerIdentity.mode === 'string') {
          const scopedIdentity = new SurfaceIdentity(accountLookupFor(sandbox));
          scopedIdentity.switchTo(resolveStoredUidIdentity(surfaceContext, callerIdentity));
          callContext = { ...surfaceContext, identity: scopedIdentity };
        }
        let outcome: OperationResult;
        if (key === 'sandbox.reset') {
          const scope = typeof args.scope === 'string' ? args.scope : 'all';
          outcome = await resetHostSandbox(ctx, scope, () => callMethod(method, args, callContext, call.allowProduction));
          if (outcome.ok && scope === 'storage') {
            await persistence.storage.reset();
          }
        } else if (key === 'functions.fire') {
          // Suppress RTDB relay snapshots only to pre-existing background
          // Functions trigger-runner children during a synthetic `functions.fire`
          // run so live triggers do not cascade on or overwrite the synthetic
          // handler's writes, while normal `connectRemoteSandbox()` consumers
          // continue receiving live snapshots without interruption.
          const suppressedSessions: string[] = [];
          for (const [sessionId, ownedPort] of ports) {
            if (ownedPort.transport !== 'worker-relay') continue;
            if (!backgroundFunctionsSessions.has(sessionId)) continue;
            suppressedSessions.push(sessionId);
            suppressedRelaySnapshotCounts.set(
              sessionId,
              (suppressedRelaySnapshotCounts.get(sessionId) ?? 0) + 1,
            );
          }
          try {
            outcome = await callMethod(method, args, callContext, call.allowProduction);
          } finally {
            for (const sessionId of suppressedSessions) {
              const nextCount = (suppressedRelaySnapshotCounts.get(sessionId) ?? 1) - 1;
              if (nextCount <= 0) suppressedRelaySnapshotCounts.delete(sessionId);
              else suppressedRelaySnapshotCounts.set(sessionId, nextCount);
            }
          }
        } else {
          outcome = await callMethod(method, args, callContext, call.allowProduction);
        }
        if (outcome.ok) {
          if (key === 'sandbox.reset') {
            const scope = typeof args.scope === 'string' ? args.scope : 'all';
            if (scope === 'all') {
              reconcilePortSessions();
              restoreFirestoreSubscriptions(ctx);
            } else if (scope === 'firestore') {
              restoreFirestoreSubscriptions(ctx);
            } else if (scope === 'auth') {
              reconcilePortSessions();
            }
          } else if (key === 'rules.set') {
            if (args.service === 'firestore' && typeof args.rules === 'string') {
              deployFirestoreRulesToHost(ctx, args.rules);
              restoreFirestoreSubscriptions(ctx);
              recorder?.note({ kind: 'rules', at: Date.now(), service: 'firestore', source: args.rules });
            } else if (args.service === 'database') {
              const dbSource = typeof args.rules === 'string' ? args.rules : args.rules === undefined ? null : JSON.stringify(args.rules);
              const rawInstance = typeof args.instance === 'string' ? args.instance : undefined;
              setDatabaseRules(ctx, rawInstance, dbSource);
              const targetSelector = rtdbInstance(ctx, rawInstance).selector;
              recorder?.note({
                kind: 'rules',
                at: Date.now(),
                service: 'database',
                ...(targetSelector === undefined ? {} : { instance: targetSelector }),
                source: dbSource,
              });
            } else if (args.service === 'storage') {
              recorder?.note({ kind: 'rules', at: Date.now(), service: 'storage', source: typeof args.rules === 'string' ? args.rules : null });
            }
          } else if (key === 'sandbox.seed' || key === 'sandbox.seedFromFixture' || key === 'sandbox.restore' || key === 'sandbox.promote') {
            syncFirestoreActiveRulesFromSandbox();
            syncDatabaseActiveRulesFromSandbox(key === 'sandbox.restore' || key === 'sandbox.promote');
            reconcilePortSessions();
            restoreFirestoreSubscriptions(ctx);
          }
          // auth.deleteUser and a disable leave signed-in ports alone; their
          // next refresh is refused and signs them out (#1950).
        }
        if (changesDurableState) outcome = await persistMutationResult(outcome);
        const isRead = method.effect === 'read';
        if (isRead) return describeRead(outcome);
        return outcome;
      }).finally(reservation.release);
      const pending = result.then(() => {}, () => {});
      owned.pending = pending;
      methodWork.set(connection, owned);
      void pending.then(() => {
        const isLastCall = owned.pending === pending;
        if (isLastCall) methodWork.delete(connection);
      });
      return result;
    },
    receive(message: BridgeMessage): void {
      if (closed) return;
      switch (message.type) {
        case 'tool-call':
          enqueueToolCall(message);
          return;
        case 'worker-message': {
          const clientSessionId = message.clientSessionId;
          const hasSession = clientSessionId !== undefined;
          if (hasSession) enqueue(clientSessionId, message.message, 'worker-port', message.platform);
          return;
        }
        case 'worker-op': {
          const clientSessionId = message.clientSessionId;
          const hasSession = clientSessionId !== undefined;
          if (hasSession) {
            enqueue(clientSessionId, { ...message.op, t: 'op', id: message.id, issuer: undefined, relaySource: 'remote' }, 'worker-relay');
          }
          return;
        }
        case 'worker-sub': {
          const isEventStream = message.sub.target === 'events';
          if (isEventStream) {
            send({
              type: 'worker-snap',
              subId: message.subId,
              clientSessionId: message.clientSessionId,
              value: { __error: { code: 'unimplemented', message: 'Event-stream subscriptions require bounded relay delivery.' } },
            });
            return;
          }
          const clientSessionId = message.clientSessionId;
          const hasSession = clientSessionId !== undefined;
          if (hasSession) {
            enqueue(clientSessionId, { ...message.sub, t: 'sub', subId: message.subId, issuer: undefined, relaySource: 'remote' }, 'worker-relay');
          }
          return;
        }
        case 'worker-unsub': {
          const clientSessionId = message.clientSessionId;
          const hasSession = clientSessionId !== undefined;
          if (hasSession) enqueue(clientSessionId, { t: 'unsub', subId: message.subId }, 'worker-relay');
          return;
        }
        case 'consumer-presence': {
          backgroundFunctionsSessions.clear();
          for (const consumer of message.consumers) {
            if (consumer.deviceLabel === FUNCTIONS_RTDB_CHILD_DEVICE_LABEL) {
              backgroundFunctionsSessions.add(consumer.clientSessionId);
            }
          }
          return;
        }
        case 'worker-client-disconnect':
          backgroundFunctionsSessions.delete(message.clientSessionId);
          void closePort(message.clientSessionId);
          return;
        case 'worker-client-interrupted':
          interruptPort(message.clientSessionId);
          return;
      }
    },
    close(): Promise<void> {
      const closing = closePromise;
      const isClosing = closing !== undefined;
      if (isClosing) return closing;
      closed = true;
      closePromise = (async () => {
        try {
          const pendingCalls = [...methodWork.values(), ...toolWork.values()].map(queue => queue.pending);
          const portClosures = [...ports.keys()].map(closePort);
          await Promise.all([...pendingCalls, ...portClosures, ...closingPorts, seedRunner.pending()]);
          await persistenceWork;
          const healthy = persistenceIsHealthy();
          if (healthy) await flushPersistence();
        } finally {
          unsubscribeFailure();
          unsubscribeAiDiagnostics();
          initialized.dispose();
          sandbox.dispose();
          closeOwnedPersistence();
          if (recordedUploadsDir !== undefined) rmSync(recordedUploadsDir, { recursive: true, force: true });
        }
      })();
      return closePromise;
    },
  };
}
