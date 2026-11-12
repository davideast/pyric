/**
 * Isolated child process runner for `functions.listTriggers` and
 * `functions.fire` (`ADR 0023` Swap-or-Stop).
 *
 * Spawned with `--import @pyric/cli/register` and `buildFunctionsChildEnv`
 * (`GOOGLE_APPLICATION_CREDENTIALS` stripped), so user Functions code never
 * loads real `firebase-admin` / `@google-cloud/*`, sees host ADC credentials,
 * or reuses stale module cache entries across edits.
 */
import { initializeSandbox } from 'pyric/sandbox';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../remote/index.js';
import { httpOnRequestFamily } from '../../functions/http/discovery.js';
import { loadFunctionsModuleExports } from '../../functions/module-loader.js';
import { serveInstanceAsDefault } from '../../functions/rtdb/child-runtime.js';
import {
  inspectOnValueCreated,
  rtdbCreatedFamily,
  type UnsupportedOnValueCreated,
} from '../../functions/rtdb/discovery.js';
import { executeOnValueCreated } from '../../functions/rtdb/event.js';
import { matchRtdbReference } from '../../functions/rtdb/reference-pattern.js';
import { findUnsupportedTriggers } from '../../functions/unsupported.js';

export interface SerializedTriggerDescriptor {
  exportName: string;
  reference: string;
  instance: string;
  location?: string;
}

export type FunctionsRunnerRequest =
  | {
      type: 'discover';
      entry: string;
      projectId: string;
      defaultInstance: string;
      databaseHost: string;
      ipcSandbox: boolean;
    }
  | {
      type: 'fire';
      entry: string;
      projectId: string;
      defaultInstance: string;
      databaseHost: string;
      ipcSandbox: boolean;
      triggerName: string;
      path: string;
      ref: string;
      value: unknown;
      eventId: string;
      eventTime: string;
    };

export type FunctionsRunnerReply =
  | {
      type: 'discovered';
      triggers: SerializedTriggerDescriptor[];
      unsupported: UnsupportedOnValueCreated[];
    }
  | { type: 'not-found' }
  | { type: 'mismatch'; trigger: SerializedTriggerDescriptor }
  | { type: 'firing'; trigger: SerializedTriggerDescriptor; params: Record<string, string> }
  | {
      type: 'executed';
      status: 'fulfilled' | 'rejected';
      event: Record<string, unknown>;
      result?: unknown;
      errorMessage?: string;
    }
  | { type: 'fatal'; message: string; stack?: string }
  | { type: 'ipc-bridge'; frame: BridgeMessage };

export type FunctionsParentToChild =
  | FunctionsRunnerRequest
  | { type: 'ipc-bridge'; frame: BridgeMessage };

export const FUNCTIONS_RUNNER_CHILD_ENV = 'PYRIC_FUNCTIONS_RUNNER_CHILD';
const SANDBOX_FACTORY = Symbol.for('pyric.remote.sandboxFactory');
const DEFAULT_LOCATION = 'us-central1';

function serializeTrigger(trigger: {
  exportName: string;
  reference: string;
  instance: string;
  location?: string;
}): SerializedTriggerDescriptor {
  const out: SerializedTriggerDescriptor = {
    exportName: trigger.exportName,
    reference: trigger.reference,
    instance: trigger.instance,
  };
  if (trigger.location !== undefined) out.location = trigger.location;
  return out;
}

function sendReply(message: FunctionsRunnerReply): Promise<void> {
  return new Promise((resolve) => {
    if (typeof process.send !== 'function' || !process.connected) {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });
}

function installIpcSandboxFactory(): () => void {
  const core = createRemoteSandboxCore(
    {
      send(frame: BridgeMessage) {
        if (typeof process.send === 'function' && process.connected) {
          process.send({ type: 'ipc-bridge', frame } satisfies FunctionsRunnerReply);
        }
      },
    },
    { serveUrl: 'ipc://functions-fire' },
  );
  const onParentMessage = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as { type?: unknown; frame?: unknown };
    if (msg.type === 'ipc-bridge' && msg.frame && typeof msg.frame === 'object') {
      core.handleMessage(msg.frame as BridgeMessage);
    }
  };
  process.on('message', onParentMessage);
  core.start();
  core.handleMessage({
    type: 'attach-ack',
    protocol: 1,
    bridgeVersion: '0.1.0',
    clientSessionId: 'ipc-functions',
    peerConnected: true,
    capabilities: [WORKER_RELAY_CAPABILITY],
  });
  const handle = createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl: 'ipc://functions-fire',
    close: () => {
      process.off('message', onParentMessage);
      core.dispose('functions child closing');
    },
  });
  (globalThis as Record<symbol, unknown>)[SANDBOX_FACTORY] = () => handle;
  return () => {
    handle.close();
  };
}

function installLocalFallbackFactory(): () => void {
  const local = initializeSandbox();
  (globalThis as Record<symbol, unknown>)[SANDBOX_FACTORY] = () => local;
  return () => {
    local.dispose();
  };
}

async function handleRunnerRequest(req: FunctionsRunnerRequest): Promise<void> {
  const usesHostedUrl = (process.env.PYRIC_SANDBOX ?? '').startsWith('remote:');
  let cleanupSandbox: () => void = () => {};
  if (!usesHostedUrl) {
    if (req.ipcSandbox) cleanupSandbox = installIpcSandboxFactory();
    else cleanupSandbox = installLocalFallbackFactory();
  }

  const { initializeApp, deleteApp } = await import('pyric-admin/app');
  serveInstanceAsDefault(req.defaultInstance);
  const ambientApp = initializeApp();

  try {
    const exported = await loadFunctionsModuleExports(req.entry);
    const inspected = inspectOnValueCreated(exported);
    const unsupported = findUnsupportedTriggers(exported, [rtdbCreatedFamily, httpOnRequestFamily]);

    if (req.type === 'discover') {
      await sendReply({
        type: 'discovered',
        triggers: inspected.triggers.map(serializeTrigger),
        unsupported,
      });
      return;
    }

    const trigger = inspected.triggers.find((candidate) => candidate.exportName === req.triggerName);
    if (trigger === undefined) {
      await sendReply({ type: 'not-found' });
      return;
    }

    const params = matchRtdbReference(trigger.reference, req.path);
    const serialized = serializeTrigger(trigger);
    if (params === null) {
      await sendReply({ type: 'mismatch', trigger: serialized });
      return;
    }

    await sendReply({ type: 'firing', trigger: serialized, params });

    const instance = trigger.instance === '*' ? req.defaultInstance : trigger.instance;
    const executed = await executeOnValueCreated(
      trigger,
      { ref: req.ref, params, value: req.value },
      {
        id: req.eventId,
        time: req.eventTime,
        instance,
        location: trigger.location ?? DEFAULT_LOCATION,
        databaseHost: req.databaseHost,
      },
    );

    if (executed.status === 'fulfilled') {
      await sendReply({
        type: 'executed',
        status: 'fulfilled',
        event: executed.event,
        result: executed.result,
      });
    } else {
      const errorMessage =
        executed.error instanceof Error ? executed.error.message : String(executed.error);
      await sendReply({
        type: 'executed',
        status: 'rejected',
        event: executed.event,
        errorMessage,
      });
    }
  } finally {
    await deleteApp(ambientApp).catch(() => undefined);
    cleanupSandbox();
  }
}

if (process.env[FUNCTIONS_RUNNER_CHILD_ENV] === '1') {
  const onInitialMessage = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as { type?: unknown };
    if (msg.type !== 'discover' && msg.type !== 'fire') return;
    process.off('message', onInitialMessage);
    void handleRunnerRequest(raw as FunctionsRunnerRequest)
      .then(() => {
        if (typeof process.disconnect === 'function' && process.connected) {
          process.disconnect();
        }
        process.exit(0);
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        await sendReply({ type: 'fatal', message, stack });
        if (typeof process.disconnect === 'function' && process.connected) {
          process.disconnect();
        }
        process.exit(1);
      });
  };
  process.on('message', onInitialMessage);
}
