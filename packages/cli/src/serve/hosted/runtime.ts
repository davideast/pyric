import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { directoryCheckpointBackend } from 'pyric/sandbox/checkpoints/directory';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getFirestore } from 'pyric/firestore';
import { FirebaseError } from 'pyric/app';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { assertJsonSafeRelayValue, MAX_PENDING_OPERATIONS, type BridgeMessage, type ToolCallRequest, type WorkerResFrame } from '../../bridge/protocol.js';
import { dispatchSandboxTool, SANDBOX_TOOL_NAMES } from '../../bridge/client/dispatch.js';
import { sandboxToolEffect } from '../../bridge/tool-families.js';
import { createSurfaceContext } from '../../bridge/surface/context.js';
import { callMethod } from '../../bridge/surface/method-call.js';
import { methodByKey } from '../../bridge/surface/methods/registry.js';
import type { OperationResult } from '../../bridge/surface/types.js';
import type { InitPayload } from '../init-payload.js';
import { applyServeInit } from '../worker/serve-init.js';
import { cleanupPortWithDisconnect, handleMessage, type HostCtx, type PortLike } from '../worker/host.js';
import { drainPortRtdbDisconnects } from '../worker/host/rtdb.js';
import { serializeError, type InboundMessage, type OutboundMessage } from '../worker/protocol.js';
import { createHostedPersistence } from './persistence.js';
import { requiresHealthyPersistence } from './persistence-admission.js';

type HostedTransport = 'worker-port' | 'worker-relay';

interface HostedPort {
  port: PortLike;
  pending: Promise<void>;
  pendingOperations: number;
}

/** One Node-owned sandbox; each admitted consumer owns its ordered work. */
export async function createHostedRuntime(
  payload: InitPayload,
  baseUrl: string,
  send: (message: BridgeMessage) => void,
  projectDir: string,
) {
  const ownedProjectDir = realpathSync(projectDir);
  const persistence = createHostedPersistence(ownedProjectDir);
  const sandbox = createSandboxRoot();
  const instanceId = randomUUID();
  await sandbox.enablePersistence({ key: instanceId, injectedBackend: persistence.backend });
  let persistenceHealthy = true;
  let persistenceWork = Promise.resolve();
  function flushPersistence(): Promise<void> {
    // An older asynchronous snapshot must finish before the next one starts.
    const flushed = persistenceWork.then(persistState);
    // The requesting caller receives failures; later accepted work still drains.
    persistenceWork = flushed.catch(() => {});
    return flushed;
  }
  async function persistState(): Promise<void> {
    try {
      await sandbox.flush();
      await persistence.flushStorage(storage);
    } catch (error) {
      persistenceHealthy = false;
      console.error('[pyric hosted] persistence failed:', error);
      throw new FirebaseError('committed-but-not-durable',
        'The mutation committed in memory but could not be persisted. Do not repeat it; restore persistence before further mutations.');
    }
  }
  function requireHealthyPersistence(): void {
    if (persistenceHealthy) return;
    throw new FirebaseError('persistence-unhealthy',
      'The mutation was not executed because hosted persistence is unhealthy. Reads reflect in-memory state. Restore persistence and restart the host before further mutations.');
  }

  function describeRead(result: OperationResult): OperationResult {
    const readsUnhealthyMemory = result.ok && !persistenceHealthy;
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
  const ctx: HostCtx = {
    sandbox,
    flushPersistence,
    db: getFirestore(sandbox),
    instanceId,
    subs: new Map(),
    checkpointBackend: directoryCheckpointBackend(ownedProjectDir),
    sessionMode: 'NONE',
  };
  const hostedFetch: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const isRelativeUrl = typeof input === 'string';
      const request = isRelativeUrl ? new URL(input, baseUrl) : input;
      return fetch(request, init);
    },
    { preconnect: fetch.preconnect },
  );
  const initialized = applyServeInit(ctx, payload, { fetch: hostedFetch });
  const storage = getAdminStorageSandbox(sandbox);
  try {
    await persistence.restoreStorage(storage);
  } catch (error) {
    initialized.dispose();
    sandbox.dispose();
    throw error;
  }
  const surfaceContext = createSurfaceContext(sandbox, ownedProjectDir);
  const ports = new Map<string, HostedPort>();
  let toolWork = Promise.resolve();
  let closed = false;

  async function handleToolCall(message: ToolCallRequest): Promise<void> {
    try {
      const effect = sandboxToolEffect(message.name);
      const changesState = effect === 'write';
      if (changesState) requireHealthyPersistence();
      let result = await dispatchSandboxTool(sandbox, message.name, message.args, message.actAs);
      if (changesState) result = await persistMutationResult(result);
      const isRead = effect === 'read';
      if (isRead) result = describeRead(result);
      send({ type: 'tool-result', id: message.id, ok: true, result });
    } catch (error) {
      send({ type: 'tool-result', id: message.id, ok: false, error: serializeError(error) });
    }
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
      let value = message.value;
      try {
        assertJsonSafeRelayValue('hosted subscription', value);
      } catch (error) {
        value = { __error: serializeError(error) };
      }
      send({ type: 'worker-snap', clientSessionId, subId: message.subId, value });
    }
  }

  function portFor(clientSessionId: string, transport: HostedTransport): HostedPort {
    const existing = ports.get(clientSessionId);
    const hasExistingPort = existing !== undefined;
    if (hasExistingPort) return existing;
    const port: PortLike = {
      postMessage(message) {
        const usesWorkerRelay = transport === 'worker-relay';
        if (usesWorkerRelay) relayMessage(clientSessionId, message);
        else send({ type: 'worker-message-result', clientSessionId, message });
      },
    };
    const owned = { port, pending: Promise.resolve(), pendingOperations: 0 };
    ports.set(clientSessionId, owned);
    return owned;
  }

  function enqueue(clientSessionId: string, incoming: InboundMessage, transport: HostedTransport): void {
    const owned = portFor(clientSessionId, transport);
    const isOperation = incoming.t === 'op' || incoming.t === 'tool';
    if (isOperation) {
      const hasReachedCapacity = owned.pendingOperations >= MAX_PENDING_OPERATIONS;
      if (hasReachedCapacity) {
        owned.port.postMessage({ t: 'res', id: incoming.id, ok: false, error: {
          code: 'resource-exhausted', message: 'This client already has 256 pending operations.',
        } });
        return;
      }
      owned.pendingOperations += 1;
    }
    // Admission owns identity. A payload cannot address another app's port.
    const message = { ...incoming, clientSessionId: undefined, resumeSession: undefined };
    owned.pending = owned.pending.then(() => {
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
      if (isOperation) owned.pendingOperations -= 1;
    });
  }

  async function closePort(clientSessionId: string): Promise<void> {
    const owned = ports.get(clientSessionId);
    const isMissingPort = owned === undefined;
    if (isMissingPort) return;
    ports.delete(clientSessionId);
    await owned.pending;
    await cleanupPortWithDisconnect(ctx, owned.port);
  }

  function interruptPort(clientSessionId: string): void {
    const owned = ports.get(clientSessionId);
    const isMissingPort = owned === undefined;
    if (isMissingPort) return;
    owned.pending = owned.pending.then(() => drainPortRtdbDisconnects(ctx, owned.port)).catch((error: unknown) => {
      console.error('[pyric hosted] RTDB disconnect cleanup failed:', error);
    });
  }

  return {
    instanceId,
    toolNames: SANDBOX_TOOL_NAMES,
    runMethod(key: string, args: Record<string, unknown>, callerProjectDir: string): Promise<OperationResult> {
      if (closed) return Promise.resolve({ ok: false, summary: 'The hosted sandbox is closed.' });
      const projectDistance = relative(ownedProjectDir, callerProjectDir);
      const namesParentDirectory = projectDistance === '..' || projectDistance.startsWith(`..${sep}`);
      const isOutsideProject = namesParentDirectory || isAbsolute(projectDistance);
      if (isOutsideProject) return Promise.resolve({ ok: false, summary: 'The discovered host belongs to another project.' });
      const method = methodByKey(key);
      const result = toolWork.then(async () => {
        const hasMutationEffect = method.effect === 'write' || method.effect === 'destructive';
        // Held identity belongs to this caller, not the persisted sandbox.
        const changesHeldIdentity = method.operation === 'switch_auth_identity';
        const changesDurableState = hasMutationEffect && !changesHeldIdentity;
        if (changesDurableState) requireHealthyPersistence();
        let outcome = await callMethod(method, args, surfaceContext);
        if (changesDurableState) outcome = await persistMutationResult(outcome);
        const isRead = method.effect === 'read';
        if (isRead) return describeRead(outcome);
        return outcome;
      });
      toolWork = result.then(() => {}, () => {});
      return result;
    },
    receive(message: BridgeMessage): void {
      if (closed) return;
      switch (message.type) {
        case 'tool-call':
          toolWork = toolWork.then(() => handleToolCall(message));
          return;
        case 'worker-message': {
          const clientSessionId = message.clientSessionId;
          const hasSession = clientSessionId !== undefined;
          if (hasSession) enqueue(clientSessionId, message.message, 'worker-port');
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
        case 'worker-client-disconnect':
          void closePort(message.clientSessionId);
          return;
        case 'worker-client-interrupted':
          interruptPort(message.clientSessionId);
          return;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      initialized.dispose();
      try {
        await Promise.all([toolWork, ...[...ports.keys()].map(closePort)]);
      } finally {
        sandbox.dispose();
      }
    },
  };
}
