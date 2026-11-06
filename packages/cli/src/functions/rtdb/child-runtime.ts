/**
 * The RTDB create family inside the isolated Functions child: it aliases the
 * configured instance to the default one, then delivers created values to
 * the discovered `onValueCreated` handlers and reports each run to the host.
 */
import { randomUUID } from 'node:crypto';
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
import { inspectOnValueCreated } from './discovery.js';
import type { CreatedExecutionResult } from './event.js';
import {
  startOnValueCreatedExecution,
  type OnValueCreatedExecutionHost,
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
  const key = Symbol.for('pyric.remote.sandboxFactory');
  const global = globalThis as Record<symbol, unknown>;
  const factory = global[key] as ((options?: { url?: string }) => RemoteSandbox) | undefined;
  if (typeof factory !== 'function') return;
  global[key] = (options?: { url?: string }): RemoteSandbox => {
    const inner = factory(options);
    return createRemoteSandboxHandle({
      channel: aliasDefaultInstance(inner.channel, name),
      serveUrl: inner.serveUrl,
      close: () => inner.close(),
    });
  };
}

/** A channel that sends `instance: name` as the default instance. */
function aliasDefaultInstance(channel: RemoteSandboxChannel, name: string): RemoteSandboxChannel {
  const alias = (instance: unknown): unknown => (instance === name ? undefined : instance);
  return {
    op: (payload) => channel.op(
      'instance' in payload ? { ...payload, instance: alias(payload.instance) } as WorkerOpPayload : payload,
    ),
    subscribe: (sub, onSnap, onError) => {
      const target = sub.target;
      const isRtdb = typeof target === 'object' && target !== null && 'service' in target && target.service === 'rtdb';
      const aliased = isRtdb ? { ...sub, target: { ...target, instance: alias(target.instance) } } as WorkerSubPayload : sub;
      return channel.subscribe(aliased, onSnap, onError);
    },
    byteRoute: () => channel.byteRoute?.() ?? Promise.resolve(undefined),
  };
}

/** Start delivering created values to every discovered `onValueCreated` export. */
export function startRtdbChildRuntime(options: RtdbChildRuntimeOptions): OnValueCreatedExecutionHost {
  const { exported, sandbox, instance, location, databaseHost, send } = options;
  const effectiveInstances = [...new Set(
    inspectOnValueCreated(exported).triggers.map((trigger) =>
      trigger.instance === '*' ? instance : trigger.instance,
    ),
  )].sort();
  if (effectiveInstances.length > 1) {
    throw new Error(
      'Functions RTDB first slice supports one database instance; found ' +
        effectiveInstances.join(', '),
    );
  }
  // Deliver from the instance the triggers name.
  const rtdb = sandbox.rtdb.forInstance(effectiveInstances[0] ?? instance);
  return startOnValueCreatedExecution({
    exported,
    delivery: new RemoteRtdbTriggerDelivery(rtdb),
    eventOptions: async (_projection, sequence, trigger) => ({
      id: `${randomUUID()}-${sequence}`,
      // The delivery's instant is the sandbox's, not this process's: the
      // write that triggered it was stamped by that clock, and a CloudEvent
      // claiming a different `time` would contradict the data it carries.
      time: new Date(await sandboxNow(sandbox)).toISOString(),
      instance: trigger.instance === '*' ? instance : trigger.instance,
      location: trigger.location ?? location,
      databaseHost,
    }),
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
  result: CreatedExecutionResult,
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
