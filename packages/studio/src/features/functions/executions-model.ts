/**
 * Pure execution-log folding, deduplication, and formatting helpers for the
 * Pyric Studio Functions inspector.
 */

import type { SandboxEvent } from 'pyric/sandbox';
import type { FunctionExecution, FunctionExecutionStatus } from './types.js';

function normalizeExecutionStatus(raw: unknown): FunctionExecutionStatus {
  if (raw === 'rejected') return 'rejected';
  if (raw === 'timeout') return 'timeout';
  return 'fulfilled';
}

function normalizeStringRecord(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

function normalizeRetryConfig(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Fold live `service: 'functions'`, `op: 'execution_finished'` events off the
 * shared Studio sandbox event stream into normalized execution records.
 */
export function extractLiveExecutions(events: readonly SandboxEvent[]): FunctionExecution[] {
  const out: FunctionExecution[] = [];
  for (const event of events) {
    if (event.kind !== 'service_mutation') continue;
    if (event.service !== 'functions' || event.op !== 'execution_finished') continue;
    const detail = (event.detail ?? {}) as Record<string, unknown>;
    const rawTrigger = detail.trigger ?? detail.function;
    const trigger = typeof rawTrigger === 'string' && rawTrigger.length > 0 ? rawTrigger : 'unknown';
    const rawStarted = Number(detail.startedAt);
    const startedAt = Number.isFinite(rawStarted) && rawStarted > 0 ? rawStarted : event.at;
    const rawDuration = Number(detail.durationMs);
    const durationMs = Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : 0;
    const status = normalizeExecutionStatus(detail.status);
    const record: FunctionExecution = {
      id: event.id || `live-${out.length + 1}`,
      trigger,
      cause: {
        ref: typeof event.path === 'string' ? event.path : '',
        params: normalizeStringRecord(detail.params),
      },
      startedAt,
      durationMs,
      status,
      source: 'live',
    };
    if (status === 'fulfilled' && detail.result !== undefined) {
      record.result = detail.result;
    }
    if (status === 'rejected' && detail.error !== undefined) {
      record.error = String(detail.error);
    }
    const retryConfig = normalizeRetryConfig(detail.retryConfig);
    if (retryConfig !== undefined) {
      record.retryConfig = retryConfig;
    }
    out.push(record);
  }
  return out;
}

function executionFingerprint(record: FunctionExecution): string {
  return `${record.trigger}|${record.startedAt}|${record.cause.ref}|${record.status}`;
}

/**
 * Merge bridge `functions.executions` records with live event-stream records,
 * deduplicating identical runs and ordering newest-first.
 */
export function mergeExecutions(
  bridgeExecutions: readonly FunctionExecution[],
  liveExecutions: readonly FunctionExecution[],
): FunctionExecution[] {
  const byKey = new Map<string, FunctionExecution>();
  for (const record of bridgeExecutions) {
    byKey.set(executionFingerprint(record), { ...record, source: record.source ?? 'bridge' });
  }
  for (const record of liveExecutions) {
    const key = executionFingerprint(record);
    if (!byKey.has(key)) {
      byKey.set(key, { ...record, source: record.source ?? 'live' });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id),
  );
}

/** Format execution duration cleanly in ms or seconds. */
export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0 ms';
  if (durationMs < 1) return '<1 ms';
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

/** Format a JSON preview safely without throwing on circular or bigint values. */
export function formatJsonPreview(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(
      value,
      (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item),
      2,
    );
  } catch {
    return String(value);
  }
}
