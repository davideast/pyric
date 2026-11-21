import {
  CREATED_EVENT_TYPE,
  type DiscoveredOnValueCreated,
  type DiscoveredRtdbValueTrigger,
} from './discovery.js';
import {
  rtdbValuesEqual,
  type CreatedValueProjection,
  type RtdbValueProjection,
} from './projection.js';

export interface RtdbEventOptions {
  id: string;
  time: string;
  instance: string;
  location: string;
  databaseHost: string;
}

export type CreatedEventOptions = RtdbEventOptions;

export type RtdbExecutionResult =
  | { status: 'fulfilled'; event: Record<string, unknown>; result: unknown }
  | { status: 'rejected'; event: Record<string, unknown>; error: unknown };

export type CreatedExecutionResult = RtdbExecutionResult;

function canonicalizeRtdbValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const entries: Array<[number, unknown]> = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) continue;
      const mapped = canonicalizeRtdbValue(value[index]);
      if (mapped !== null) entries.push([index, mapped]);
    }
    if (entries.length === 0) return null;
    if (entries.every(([idx], pos) => idx === pos)) {
      return entries.map(([, item]) => item);
    }
    return Object.fromEntries(entries.map(([idx, item]) => [String(idx), item]));
  }
  if (typeof value !== 'object') return value;
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = canonicalizeRtdbValue((value as Record<string, unknown>)[key]);
    if (child !== null) entries.push([key, child]);
  }
  if (entries.length > 0) return Object.fromEntries(entries);
  return null;
}

/**
 * Compute the RTDB CloudEvent `delta` payload between `before` and `after` so
 * `firebase-functions`'s `applyChange(data, delta)` reconstructs `after` with
 * added/modified subtrees and `null` tombstones for deleted child keys.
 */
export function computeRtdbDelta(before: unknown, after: unknown): unknown {
  const canonicalBefore = canonicalizeRtdbValue(before);
  const canonicalAfter = canonicalizeRtdbValue(after);
  if (canonicalBefore === null) return canonicalAfter;
  if (canonicalAfter === null) return null;
  if (typeof canonicalBefore !== 'object' || typeof canonicalAfter !== 'object') {
    return canonicalAfter;
  }

  const beforeObj = canonicalBefore as Record<string, unknown>;
  const afterObj = canonicalAfter as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])].sort();
  const deltaEntries: Array<[string, unknown]> = [];

  for (const key of keys) {
    const inBefore = Object.prototype.hasOwnProperty.call(beforeObj, key);
    const inAfter = Object.prototype.hasOwnProperty.call(afterObj, key);
    if (!inAfter) {
      deltaEntries.push([key, null]);
    } else if (!inBefore) {
      deltaEntries.push([key, afterObj[key]]);
    } else if (!rtdbValuesEqual(beforeObj[key], afterObj[key])) {
      deltaEntries.push([key, computeRtdbDelta(beforeObj[key], afterObj[key])]);
    }
  }

  return Object.fromEntries(deltaEntries);
}

/** Invoke the real Firebase Functions v2 RTDB callable (`created`, `updated`, `deleted`, or `written`). */
export async function executeRtdbValueTrigger(
  trigger: DiscoveredRtdbValueTrigger,
  projection: RtdbValueProjection,
  options: RtdbEventOptions,
): Promise<RtdbExecutionResult> {
  const event: Record<string, unknown> = {
    specversion: '1.0',
    id: options.id,
    // RTDB CloudEvents use the provider resource and a `_` project segment;
    // the concrete database identity lives in `instances/<instance>`.
    source:
      '//firebasedatabase.googleapis.com/projects/_' +
      `/locations/${options.location}/instances/${options.instance}`,
    subject: `refs/${projection.ref}`,
    type: trigger.eventType,
    time: options.time,
    location: options.location,
    instance: options.instance,
    ref: projection.ref,
    firebasedatabasehost: options.databaseHost,
    authtype: 'unknown',
    authid: null,
    data: {
      data: canonicalizeRtdbValue(projection.before),
      delta: computeRtdbDelta(projection.before, projection.after),
    },
  };

  try {
    const result = await trigger.callable(event);
    return { status: 'fulfilled', event, result };
  } catch (error) {
    return { status: 'rejected', event, error };
  }
}

/** Invoke the real Firebase Functions wrapper for an `onValueCreated` projection. */
export async function executeOnValueCreated(
  trigger: DiscoveredOnValueCreated,
  projection: CreatedValueProjection,
  options: CreatedEventOptions,
): Promise<CreatedExecutionResult> {
  return await executeRtdbValueTrigger(
    { ...trigger, eventType: CREATED_EVENT_TYPE },
    {
      kind: 'created',
      ref: projection.ref,
      params: projection.params,
      before: null,
      after: projection.value,
    },
    options,
  );
}
