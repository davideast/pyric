/**
 * Pure response normalization and serve-init metadata parsing helpers for the
 * Functions bridge client.
 */

import type { ServeInitPayload } from '../../shell/serve-init.js';
import type {
  DiscoveredTrigger,
  FunctionExecution,
  UnsupportedTrigger,
} from './types.js';

interface ExtendedServeInitPayload extends ServeInitPayload {
  instanceId?: string;
  projectKey?: string | null;
  hosted?: boolean;
  databaseInstances?: {
    defaultInstance?: string;
    projectId?: string;
    rules?: Record<string, unknown | null>;
  } | null;
}

function stampedWorkerInit(): {
  instanceId?: string;
  projectKey?: string | null;
  hosted?: boolean;
  sessionToken?: string;
} | undefined {
  return (
    globalThis as {
      __PYRIC_WORKER_INIT__?: {
        instanceId?: string;
        projectKey?: string | null;
        hosted?: boolean;
        sessionToken?: string;
      };
    }
  ).__PYRIC_WORKER_INIT__;
}

/** Resolve bridge metadata from cached `/__pyric/init.json` and stamped HTML init. */
export function resolveBridgeMetadata(payload: ServeInitPayload | null): {
  hosted: boolean;
  instanceId: string | null;
  projectDir: string | null;
  projectId: string | null;
  sessionToken: string | null;
} {
  const extended = (payload ?? null) as ExtendedServeInitPayload | null;
  const stamped = stampedWorkerInit();
  const hosted = extended?.hosted === true || stamped?.hosted === true;
  const instanceId =
    (typeof extended?.instanceId === 'string' && extended.instanceId.length > 0
      ? extended.instanceId
      : null) ??
    (typeof stamped?.instanceId === 'string' && stamped.instanceId.length > 0
      ? stamped.instanceId
      : null);
  const projectDir =
    (typeof extended?.projectKey === 'string' && extended.projectKey.length > 0
      ? extended.projectKey
      : null) ??
    (typeof stamped?.projectKey === 'string' && stamped.projectKey.length > 0
      ? stamped.projectKey
      : null);
  const projectId =
    typeof extended?.databaseInstances?.projectId === 'string' &&
    extended.databaseInstances.projectId.length > 0
      ? extended.databaseInstances.projectId
      : null;
  const sessionToken =
    (typeof extended?.sessionToken === 'string' && extended.sessionToken.length > 0
      ? extended.sessionToken
      : null) ??
    (typeof stamped?.sessionToken === 'string' && stamped.sessionToken.length > 0
      ? stamped.sessionToken
      : null);
  return { hosted, instanceId, projectDir, projectId, sessionToken };
}

export function asDiscoveredTriggers(raw: unknown): DiscoveredTrigger[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is DiscoveredTrigger =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { exportName?: unknown }).exportName === 'string' &&
      typeof (item as { eventType?: unknown }).eventType === 'string',
  );
}

export function asUnsupportedTriggers(raw: unknown): UnsupportedTrigger[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is UnsupportedTrigger =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { exportName?: unknown }).exportName === 'string' &&
      typeof (item as { eventType?: unknown }).eventType === 'string',
  );
}

export function asExecutions(raw: unknown): FunctionExecution[] {
  if (!Array.isArray(raw)) return [];
  const out: FunctionExecution[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.trigger !== 'string') continue;
    const rawCause = (record.cause ?? {}) as Record<string, unknown>;
    const rawParams =
      typeof rawCause.params === 'object' &&
      rawCause.params !== null &&
      !Array.isArray(rawCause.params)
        ? (rawCause.params as Record<string, unknown>)
        : {};
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      params[k] = typeof v === 'string' ? v : String(v);
    }
    const status =
      record.status === 'rejected'
        ? 'rejected'
        : record.status === 'timeout'
          ? 'timeout'
          : 'fulfilled';
    const execution: FunctionExecution = {
      id: typeof record.id === 'string' ? record.id : String(out.length + 1),
      trigger: record.trigger,
      cause: {
        ref: typeof rawCause.ref === 'string' ? rawCause.ref : '',
        params,
      },
      startedAt: Number.isFinite(Number(record.startedAt)) ? Number(record.startedAt) : 0,
      durationMs: Number.isFinite(Number(record.durationMs)) ? Number(record.durationMs) : 0,
      status,
      source: 'bridge',
    };
    if (status === 'fulfilled' && record.result !== undefined) {
      execution.result = record.result;
    }
    if (status === 'rejected' && record.error !== undefined) {
      execution.error = String(record.error);
    }
    if (
      typeof record.retryConfig === 'object' &&
      record.retryConfig !== null &&
      !Array.isArray(record.retryConfig)
    ) {
      execution.retryConfig = record.retryConfig as Record<string, number>;
    }
    out.push(execution);
  }
  return out;
}

export async function parseResponseBody(res: Response): Promise<unknown> {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const text = await res.text();
  if (ct.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export function cleanSubpath(rawPath: string | undefined): string {
  if (!rawPath) return '';
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
