export interface RtdbSnapshotCommit {
  /** Absolute RTDB path represented by before/after. */
  path: string;
  before: unknown;
  after: unknown;
}

export interface CreatedValueProjection {
  /** Normalized RTDB ref without a leading slash, matching Functions events. */
  ref: string;
  params: Record<string, string>;
  value: unknown;
}

export type RtdbCreatedCallable = (
  rawEvent: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface DiscoveredOnValueCreated {
  exportName: string;
  reference: string;
  instance: string;
  location?: string;
  callable: RtdbCreatedCallable;
}

export interface UnsupportedOnValueCreated {
  exportName: string;
  eventType: string;
}

export interface OnValueCreatedInspection {
  triggers: DiscoveredOnValueCreated[];
  unsupported: UnsupportedOnValueCreated[];
}

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

export interface RtdbTriggerDelivery {
  subscribe(
    path: string,
    listener: (value: unknown) => void,
    onError?: (error: unknown) => void,
  ): () => void;
}

export interface OnValueCreatedExecutionOptions {
  exported: Record<string, unknown>;
  delivery: RtdbTriggerDelivery;
  eventOptions(
    projection: CreatedValueProjection,
    sequence: number,
    trigger: DiscoveredOnValueCreated,
  ): CreatedEventOptions;
  onExecution?(
    result: CreatedExecutionResult,
    trigger: DiscoveredOnValueCreated,
    projection: CreatedValueProjection,
  ): void;
  onDeliveryError?(error: unknown, trigger: DiscoveredOnValueCreated): void;
}

export interface OnValueCreatedExecutionHost {
  readonly triggerCount: number;
  readonly ready: Promise<void>;
  idle(): Promise<void>;
  close(): void;
}

const CREATED_EVENT_TYPE = 'google.firebase.database.ref.v1.created';

type EndpointFunction = RtdbCreatedCallable & {
  __endpoint?: {
    region?: unknown;
    eventTrigger?: {
      eventType?: unknown;
      eventFilters?: Record<string, unknown>;
      eventFilterPathPatterns?: Record<string, unknown>;
    };
  };
};

function supportsReference(reference: string): boolean {
  return pathParts(reference).every((segment) =>
    paramName(segment) !== null || (!segment.includes('{') && !segment.includes('}')),
  );
}

/** Classify unchanged v2 RTDB create exports against the admitted first slice. */
export function inspectOnValueCreated(
  exported: Record<string, unknown>,
): OnValueCreatedInspection {
  const triggers: DiscoveredOnValueCreated[] = [];
  const unsupported: UnsupportedOnValueCreated[] = [];
  for (const [exportName, value] of Object.entries(exported)) {
    if (typeof value !== 'function') continue;
    const callable = value as EndpointFunction;
    const trigger = callable.__endpoint?.eventTrigger;
    if (trigger?.eventType !== CREATED_EVENT_TYPE) continue;
    const reference = trigger.eventFilterPathPatterns?.ref;
    const instance =
      trigger.eventFilters?.instance ?? trigger.eventFilterPathPatterns?.instance;
    if (typeof reference !== 'string' || typeof instance !== 'string') continue;
    if (!supportsReference(reference)) {
      unsupported.push({
        exportName,
        eventType: `${CREATED_EVENT_TYPE} (unsupported ref pattern: ${reference})`,
      });
      continue;
    }
    const region = callable.__endpoint?.region;
    const location = Array.isArray(region) && typeof region[0] === 'string'
      ? region[0]
      : undefined;
    triggers.push({
      exportName,
      reference,
      instance,
      ...(location === undefined ? {} : { location }),
      callable,
    });
  }
  return { triggers, unsupported };
}

/** Discover supported unchanged v2 RTDB create functions. */
export function discoverOnValueCreated(
  exported: Record<string, unknown>,
): DiscoveredOnValueCreated[] {
  return inspectOnValueCreated(exported).triggers;
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
    source:
      `//firebase.googleapis.com/projects/${options.projectId}` +
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
      // RTDB materializes object children in key order before Functions builds
      // its DataSnapshot. Canonicalizing the event payload preserves that
      // observable `forEach()` order even when the local write object used a
      // different insertion order.
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

function normalizePath(path: string): string {
  return path.split('/').filter(Boolean).join('/');
}

function canonicalPath(path: string): string {
  const normalized = normalizePath(path);
  return normalized ? `/${normalized}` : '/';
}

/** Test adapter for the same snapshot-delivery seam the remote relay uses. */
export class InMemoryRtdbTriggerDelivery implements RtdbTriggerDelivery {
  readonly #values = new Map<string, unknown>();
  readonly #listeners = new Map<string, Set<(value: unknown) => void>>();

  seed(path: string, value: unknown): void {
    this.#values.set(canonicalPath(path), structuredClone(value));
  }

  emit(path: string, value: unknown): void {
    const key = canonicalPath(path);
    const snapshot = structuredClone(value);
    this.#values.set(key, snapshot);
    for (const listener of this.#listeners.get(key) ?? []) {
      listener(structuredClone(snapshot));
    }
  }

  subscribe(path: string, listener: (value: unknown) => void): () => void {
    const key = canonicalPath(path);
    let listeners = this.#listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(listener);
    listener(structuredClone(this.#values.get(key) ?? null));
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(key);
    };
  }
}

function pathParts(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized ? normalized.split('/') : [];
}

function exists(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function paramName(segment: string): string | null {
  return /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(segment)?.[1] ?? null;
}

function child(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function childKeys(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value).filter((key) => exists(child(value, key))).sort();
}

function watchPath(reference: string): string {
  const literal: string[] = [];
  for (const segment of pathParts(reference)) {
    if (paramName(segment)) break;
    literal.push(segment);
  }
  return canonicalPath(literal.join('/'));
}

/** Project absent-to-present values for one v2 RTDB trigger reference. */
export function projectValueCreates(
  reference: string,
  commit: RtdbSnapshotCommit,
): CreatedValueProjection[] {
  const pattern = pathParts(reference);
  const committed = pathParts(commit.path);
  if (committed.length > pattern.length) return [];

  const params: Record<string, string> = {};
  for (let index = 0; index < committed.length; index += 1) {
    const capture = paramName(pattern[index]);
    if (capture) params[capture] = committed[index];
    else if (pattern[index] !== committed[index]) return [];
  }

  const projected: CreatedValueProjection[] = [];
  const visit = (
    depth: number,
    before: unknown,
    after: unknown,
    concrete: string[],
    captures: Record<string, string>,
  ): void => {
    if (depth === pattern.length) {
      if (!exists(before) && exists(after)) {
        projected.push({
          ref: concrete.join('/'),
          params: captures,
          value: after,
        });
      }
      return;
    }

    const segment = pattern[depth];
    const capture = paramName(segment);
    if (capture) {
      for (const key of childKeys(after)) {
        visit(
          depth + 1,
          child(before, key),
          child(after, key),
          [...concrete, key],
          { ...captures, [capture]: key },
        );
      }
      return;
    }

    visit(
      depth + 1,
      child(before, segment),
      child(after, segment),
      [...concrete, segment],
      captures,
    );
  };

  visit(
    committed.length,
    commit.before,
    commit.after,
    committed,
    params,
  );
  return projected;
}

/**
 * Connect discovered functions to an abstract snapshot-delivery source.
 * The first snapshot on each subscription is a baseline, never a historical
 * create. Later handler executions share one serialized queue.
 */
export function startOnValueCreatedExecution(
  options: OnValueCreatedExecutionOptions,
): OnValueCreatedExecutionHost {
  const triggers = discoverOnValueCreated(options.exported);
  const unsubscribe: Array<() => void> = [];
  let closed = false;
  let sequence = 0;
  let tail = Promise.resolve();
  let baselinesRemaining = triggers.length;
  let readinessFailed = false;
  let markReady!: () => void;
  let failReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  if (baselinesRemaining === 0) markReady();

  for (const trigger of triggers) {
    const path = watchPath(trigger.reference);
    let hasBaseline = false;
    let previous: unknown;
    unsubscribe.push(
      options.delivery.subscribe(
        path,
        (next) => {
          if (closed) return;
          if (!hasBaseline) {
            previous = next;
            hasBaseline = true;
            baselinesRemaining -= 1;
            if (baselinesRemaining === 0 && !readinessFailed) markReady();
            return;
          }

          const before = previous;
          previous = next;
          const projections = projectValueCreates(trigger.reference, {
            path,
            before,
            after: next,
          });
          for (const projection of projections) {
            const deliverySequence = ++sequence;
            tail = tail.then(async () => {
              const result = await executeOnValueCreated(
                trigger,
                projection,
                options.eventOptions(projection, deliverySequence, trigger),
              );
              options.onExecution?.(result, trigger, projection);
            });
          }
        },
        (error) => {
          if (!hasBaseline && !readinessFailed) {
            readinessFailed = true;
            failReady(error);
          }
          options.onDeliveryError?.(error, trigger);
        },
      ),
    );
  }

  return {
    triggerCount: triggers.length,
    ready,
    idle: () => tail,
    close() {
      if (closed) return;
      closed = true;
      for (const stop of unsubscribe.splice(0)) stop();
    },
  };
}
