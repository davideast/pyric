/**
 * The v2 Cloud Storage trigger family inside the isolated Functions child:
 * aliases the configured default bucket onto the host's default bucket store,
 * subscribes to Storage mutations, and reports each execution over IPC.
 */
import { randomUUID } from 'node:crypto';
import { REMOTE_SANDBOX_FACTORY } from 'pyric/sandbox';
import type { RemoteByteRoute } from 'pyric/storage/internal';
import type { WorkerOpPayload } from '../../bridge/protocol.js';
import {
  createRemoteSandboxHandle,
  type RemoteSandbox,
  type RemoteSandboxChannel,
} from '../../remote/index.js';
import { serializeError, type FunctionsChildEvent } from '../child-protocol.js';
import { RemoteStorageTriggerDelivery } from './delivery.js';
import type { StorageExecutionResult } from './event.js';
import {
  startStorageTriggerExecution,
  type StorageTriggerExecutionHost,
} from './execution.js';

const BYTE_ROUTE_PREFIX = '/__pyric/storage/v0/b/';
const DEFAULT_STORE_BUCKET = 'pyric-default';

export interface StorageChildRuntimeOptions {
  exported: Record<string, unknown>;
  sandbox: RemoteSandbox;
  defaultBucket: string;
  location: string;
  send(event: FunctionsChildEvent): void;
}

/** Resolve the synthetic default Storage bucket name for the child process. */
export function defaultStorageBucketFromEnv(
  env: NodeJS.ProcessEnv,
  fallbackProjectId = 'demo-project',
): string {
  const rawConfig = env.FIREBASE_CONFIG;
  if (typeof rawConfig === 'string' && rawConfig.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawConfig) as { storageBucket?: unknown; projectId?: unknown };
      if (typeof parsed.storageBucket === 'string' && parsed.storageBucket.length > 0) {
        return parsed.storageBucket;
      }
      if (typeof parsed.projectId === 'string' && parsed.projectId.length > 0) {
        return `${parsed.projectId}.appspot.com`;
      }
    } catch {
      // Fall back to projectId env vars when FIREBASE_CONFIG is not JSON.
    }
  }
  let projectId = fallbackProjectId;
  if (typeof env.GCLOUD_PROJECT === 'string' && env.GCLOUD_PROJECT.length > 0) {
    projectId = env.GCLOUD_PROJECT;
  } else if (typeof env.GOOGLE_CLOUD_PROJECT === 'string' && env.GOOGLE_CLOUD_PROJECT.length > 0) {
    projectId = env.GOOGLE_CLOUD_PROJECT;
  }
  return `${projectId}.appspot.com`;
}

function aliasStorageOpBucket(payload: WorkerOpPayload, defaultBucket: string): WorkerOpPayload {
  if (!payload.method.startsWith('storage.')) return payload;
  const record = payload as Record<string, unknown>;
  let changed = false;
  const clone: Record<string, unknown> = { ...record };

  if (clone.bucket === defaultBucket) {
    delete clone.bucket;
    changed = true;
  }
  if (clone.defaultBucket === defaultBucket) {
    delete clone.defaultBucket;
    changed = true;
  }
  if (payload.method === 'storage.copyObject') {
    if (clone.destinationBucket === defaultBucket) {
      delete clone.destinationBucket;
      changed = true;
    }
    if (clone.destinationDefaultBucket === defaultBucket) {
      delete clone.destinationDefaultBucket;
      changed = true;
    }
  }
  if (!changed) return payload;
  return clone as WorkerOpPayload;
}

function rewriteDefaultBucketByteRouteInput(
  input: string | URL,
  encodedDefaultPrefix: string,
): string | URL {
  if (typeof input === 'string') {
    const url = new URL(input);
    if (url.pathname.startsWith(encodedDefaultPrefix)) {
      url.pathname =
        `${BYTE_ROUTE_PREFIX}${DEFAULT_STORE_BUCKET}/` +
        url.pathname.slice(encodedDefaultPrefix.length);
      return url.href;
    }
    return input;
  }
  if (input.pathname.startsWith(encodedDefaultPrefix)) {
    const rewritten = new URL(input.href);
    rewritten.pathname =
      `${BYTE_ROUTE_PREFIX}${DEFAULT_STORE_BUCKET}/` +
      input.pathname.slice(encodedDefaultPrefix.length);
    return rewritten;
  }
  return input;
}

function aliasDefaultBucketByteRoute(
  route: RemoteByteRoute | undefined,
  defaultBucket: string,
): RemoteByteRoute | undefined {
  if (route === undefined) return undefined;
  const encodedPrefix = `${BYTE_ROUTE_PREFIX}${encodeURIComponent(defaultBucket)}/`;
  const baseFetch = route.fetch ?? fetch;
  return {
    baseUrl: route.baseUrl,
    sessionToken: () => route.sessionToken(),
    fetch: (input, init) =>
      baseFetch(rewriteDefaultBucketByteRouteInput(input, encodedPrefix), init),
  };
}

function aliasDefaultStorageChannel(
  channel: RemoteSandboxChannel,
  defaultBucket: string,
): RemoteSandboxChannel {
  return {
    op: (payload) => channel.op(aliasStorageOpBucket(payload, defaultBucket)),
    subscribe: (sub, onSnap, onError) => channel.subscribe(sub, onSnap, onError),
    byteRoute: async () => {
      const route = await channel.byteRoute?.();
      return aliasDefaultBucketByteRoute(route, defaultBucket);
    },
  };
}

/**
 * Wrap the ambient remote sandbox factory so `firebase-admin/storage` calls for
 * the child's synthetic default bucket (`<projectId>.appspot.com`) reach the
 * host's default bucket store even when unnamed uploads arrived earlier.
 */
export function serveBucketAsDefault(defaultBucket: string): void {
  if (!defaultBucket || defaultBucket === DEFAULT_STORE_BUCKET) return;
  const globalRecord = globalThis as Record<symbol, unknown>;
  const factory = globalRecord[REMOTE_SANDBOX_FACTORY] as
    | ((options?: { url?: string }) => RemoteSandbox)
    | undefined;
  if (typeof factory !== 'function') return;
  globalRecord[REMOTE_SANDBOX_FACTORY] = (options?: { url?: string }): RemoteSandbox => {
    const inner = factory(options);
    return createRemoteSandboxHandle({
      channel: aliasDefaultStorageChannel(inner.channel, defaultBucket),
      serveUrl: inner.serveUrl,
      close: () => inner.close(),
    });
  };
}

async function sandboxNow(sandbox: RemoteSandbox): Promise<number> {
  const read = (await sandbox.channel.op({ method: 'sandbox.clock' })) as { now: number };
  return read.now;
}

function executionEvent(
  result: StorageExecutionResult,
  exportName: string,
  ref: string,
): FunctionsChildEvent {
  if (result.status === 'fulfilled') {
    return { type: 'execution', exportName, ref, params: {}, status: 'fulfilled' };
  }
  return {
    type: 'execution',
    exportName,
    ref,
    params: {},
    status: 'rejected',
    error: serializeError(result.error),
  };
}

/** Start delivering Storage object events to discovered Storage triggers. */
export function startStorageChildRuntime(
  options: StorageChildRuntimeOptions,
): StorageTriggerExecutionHost {
  const { exported, sandbox, defaultBucket, location, send } = options;
  return startStorageTriggerExecution({
    exported,
    defaultBucket,
    delivery: new RemoteStorageTriggerDelivery(sandbox.channel, { defaultBucket }),
    eventOptions: async (projected, sequence, trigger) => {
      let timestampMs = projected.at;
      if (timestampMs <= 0) {
        timestampMs = await sandboxNow(sandbox);
      }
      return {
        id: `${randomUUID()}-${sequence}`,
        time: new Date(timestampMs).toISOString(),
        location: trigger.location ?? location,
      };
    },
    onExecution(result, trigger, projected) {
      const ref = `${projected.bucket}/${projected.object.fullPath}`;
      send(executionEvent(result, trigger.exportName, ref));
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
