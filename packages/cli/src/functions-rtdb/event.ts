import { CREATED_EVENT_TYPE, type DiscoveredOnValueCreated } from './discovery.js';
import type { CreatedValueProjection } from './projection.js';

export interface CreatedEventOptions {
  id: string;
  time: string;
  projectId: string;
  instance: string;
  location: string;
  databaseHost: string;
}

export type CreatedExecutionResult =
  | { status: 'fulfilled'; event: Record<string, unknown> }
  | { status: 'rejected'; event: Record<string, unknown>; error: unknown };

function canonicalizeRtdbValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeRtdbValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        canonicalizeRtdbValue((value as Record<string, unknown>)[key]),
      ]),
  );
}

/** Invoke the real Firebase Functions wrapper and await the user's result. */
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
    await trigger.callable(event);
    return { status: 'fulfilled', event };
  } catch (error) {
    return { status: 'rejected', event, error };
  }
}
