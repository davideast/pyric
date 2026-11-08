import { CREATED_EVENT_TYPE, type DiscoveredOnValueCreated } from './discovery.js';
import type { CreatedValueProjection } from './projection.js';

export interface CreatedEventOptions {
  id: string;
  time: string;
  instance: string;
  location: string;
  databaseHost: string;
}

export type CreatedExecutionResult =
  | { status: 'fulfilled'; event: Record<string, unknown>; result: unknown }
  | { status: 'rejected'; event: Record<string, unknown>; error: unknown };

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
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = canonicalizeRtdbValue((value as Record<string, unknown>)[key]);
    if (child !== null) entries.push([key, child]);
  }
  if (entries.length > 0) return Object.fromEntries(entries);
  return null;
}

/** Invoke the real Firebase Functions wrapper and await the user's result, carrying it through on success. */
export async function executeOnValueCreated(
  trigger: DiscoveredOnValueCreated,
  projection: CreatedValueProjection,
  options: CreatedEventOptions,
): Promise<CreatedExecutionResult> {
  const event: Record<string, unknown> = {
    specversion: '1.0',
    id: options.id,
    // RTDB CloudEvents use the provider resource and a `_` project segment;
    // the concrete database identity lives in `instances/<instance>`.
    source:
      '//firebasedatabase.googleapis.com/projects/_' +
      `/locations/${options.location}/instances/${options.instance}`,
    subject: `refs/${projection.ref}`,
    type: CREATED_EVENT_TYPE,
    time: options.time,
    location: options.location,
    instance: options.instance,
    ref: projection.ref,
    firebasedatabasehost: options.databaseHost,
    authtype: 'unknown',
    authid: null,
    data: {
      data: null,
      delta: canonicalizeRtdbValue(projection.value),
    },
  };

  try {
    const result = await trigger.callable(event);
    return { status: 'fulfilled', event, result };
  } catch (error) {
    return { status: 'rejected', event, error };
  }
}
