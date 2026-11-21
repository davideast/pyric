/**
 * The v2 RTDB trigger family inside the isolated Functions child: it aliases
 * the configured instance to the default one, then delivers created, updated,
 * deleted, and written value transitions to the discovered handlers and reports
 * each run to the host.
 */
import { randomUUID } from 'node:crypto';
import { REMOTE_SANDBOX_FACTORY } from 'pyric/sandbox';
import { parsePyricSandbox } from 'pyric/sandbox/internal';
import type { WorkerOpPayload, WorkerSubPayload } from '../../bridge/protocol.js';
import {
  createRemoteSandboxHandle,
  type RemoteSandbox,
  type RemoteSandboxChannel,
} from '../../remote/index.js';
import {
  serializeError,
  type FunctionsChildEvent,
} from '../child-protocol.js';
import { inspectRtdbValueTriggers } from './discovery.js';
import type { RtdbExecutionResult } from './event.js';
import {
  startRtdbValueExecution,
  type RtdbValueExecutionHost,
} from './execution.js';
import { RemoteRtdbTriggerDelivery } from './remote-delivery.js';

export interface RtdbChildRuntimeOptions {
  exported: Record<string, unknown>;
  sandbox: RemoteSandbox;
  instance: string;
  location: string;
  databaseHost: string;
  send(event: FunctionsChildEvent): void;
}

/**
 * Mint a remote sandbox handle directly from the installed ambient factory
 * without pre-initializing `firebase-admin/app`'s `[DEFAULT]` app before user
 * module code runs.
 */
export function connectAmbientRuntimeSandbox(env: NodeJS.ProcessEnv = process.env): RemoteSandbox {
  const global = globalThis as Record<symbol, unknown>;
  const factory = global[REMOTE_SANDBOX_FACTORY] as ((options?: { url?: string }) => RemoteSandbox) | undefined;
  if (typeof factory !== 'function') {
    throw new Error('Functions child is missing the installed remote sandbox factory');
  }
  const parsed = parsePyricSandbox(env.PYRIC_SANDBOX ?? '');
  if (parsed.mode === 'remote' && parsed.url !== undefined) {
    return factory({ url: parsed.url });
  }
  return factory({});
}

/** The current instant of the sandbox this child is attached to. */
async function sandboxNow(sandbox: RemoteSandbox): Promise<number> {
  const read = (await sandbox.channel.op({ method: 'sandbox.clock' })) as { now: number };
  return read.now;
}

/**
 * The configured instance name is the name of the default instance: the
 * `functions.instance` option renames `<projectId>-default-rtdb`, and the host
 * serves that instance without a name. Wrap the remote sandbox factory that
 * `@pyric/cli/register` installs so every RTDB op and value subscription this
 * child sends for `name`, from firebase-admin or from trigger delivery,
 * reaches the default instance.
 */
export function serveInstanceAsDefault(name: string): void {
  const global = globalThis as Record<symbol, unknown>;
  const factory = global[REMOTE_SANDBOX_FACTORY] as ((options?: { url?: string }) => RemoteSandbox) | undefined;
  if (typeof factory !== 'function') return;
  global[REMOTE_SANDBOX_FACTORY] = (options?: { url?: string }): RemoteSandbox => {
    const inner = factory(options);
    return createRemoteSandboxHandle({
      channel: aliasDefaultInstance(inner.channel, name),
      serveUrl: inner.serveUrl,
      close: () => inner.close(),
    });
  };
}

function aliasInstanceValue(instance: unknown, name: string): unknown {
  if (instance === name) return undefined;
  return instance;
}

/** A channel that sends `instance: name` as the default instance. */
function aliasDefaultInstance(channel: RemoteSandboxChannel, name: string): RemoteSandboxChannel {
  return {
    op: (payload) => {
      if ('instance' in payload) {
        return channel.op({
          ...payload,
          instance: aliasInstanceValue(payload.instance, name),
        } as WorkerOpPayload);
      }
      return channel.op(payload);
    },
    subscribe: (sub, onSnap, onError) => {
      const target = sub.target;
      const isRtdb =
        typeof target === 'object' &&
        target !== null &&
        'service' in target &&
        target.service === 'rtdb';
      if (isRtdb) {
        const aliased = {
          ...sub,
          target: { ...target, instance: aliasInstanceValue(target.instance, name) },
        } as WorkerSubPayload;
        return channel.subscribe(aliased, onSnap, onError);
      }
      return channel.subscribe(sub, onSnap, onError);
    },
    byteRoute: () => channel.byteRoute?.() ?? Promise.resolve(undefined),
  };
}

/** Start delivering value transitions to every discovered v2 RTDB trigger export. */
export function startRtdbChildRuntime(options: RtdbChildRuntimeOptions): RtdbValueExecutionHost {
  const { exported, sandbox, instance, location, databaseHost, send } = options;
  const effectiveInstances = [...new Set(
    inspectRtdbValueTriggers(exported).triggers.map((trigger) => {
      if (trigger.instance === '*') return instance;
      return trigger.instance;
    }),
  )].sort();
  if (effectiveInstances.length > 1) {
    throw new Error(
      'Functions RTDB first slice supports one database instance; found ' +
        effectiveInstances.join(', '),
    );
  }
  // Deliver from the instance the triggers name.
  const targetInstance = effectiveInstances[0] ?? instance;
  const rtdb = sandbox.rtdb.forInstance(targetInstance);
  return startRtdbValueExecution({
    exported,
    delivery: new RemoteRtdbTriggerDelivery(rtdb),
    eventOptions: async (_projection, sequence, trigger) => {
      let resolvedInstance = trigger.instance;
      if (resolvedInstance === '*') resolvedInstance = instance;
      return {
        id: `${randomUUID()}-${sequence}`,
        // The delivery's instant is the sandbox's, not this process's: the
        // write that triggered it was stamped by that clock, and a CloudEvent
        // claiming a different `time` would contradict the data it carries.
        time: new Date(await sandboxNow(sandbox)).toISOString(),
        instance: resolvedInstance,
        location: trigger.location ?? location,
        databaseHost,
      };
    },
    onExecution(result, trigger, projection) {
      send(executionEvent(result, trigger.exportName, projection.ref, projection.params));
    },
    onDeliveryError(error, trigger) {
      send({
        type: 'delivery-error',
        exportName: trigger.exportName,
        error: serializeError(error),
      });
    },
  });
}

function executionEvent(
  result: RtdbExecutionResult,
  exportName: string,
  ref: string,
  params: Record<string, string>,
): FunctionsChildEvent {
  if (result.status === 'fulfilled') {
    return { type: 'execution', exportName, ref, params, status: 'fulfilled' };
  }
  return {
    type: 'execution',
    exportName,
    ref,
    params,
    status: 'rejected',
    error: serializeError(result.error),
  };
}
