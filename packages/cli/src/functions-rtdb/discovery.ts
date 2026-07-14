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

export const CREATED_EVENT_TYPE = 'google.firebase.database.ref.v1.created';

export type FirebaseEndpointFunction = RtdbCreatedCallable & {
  __endpoint?: {
    omit?: unknown;
    region?: unknown;
    eventTrigger?: {
      eventType?: unknown;
      eventFilters?: Record<string, unknown>;
      eventFilterPathPatterns?: Record<string, unknown>;
    };
    callableTrigger?: unknown;
    httpsTrigger?: unknown;
    scheduleTrigger?: unknown;
    taskQueueTrigger?: unknown;
  };
};

/** Walk exports using the same hyphenated nested names as Firebase's loader. */
export function listFirebaseEndpoints(
  exported: Record<string, unknown>,
): Array<{ exportName: string; callable: FirebaseEndpointFunction }> {
  const endpoints: Array<{ exportName: string; callable: FirebaseEndpointFunction }> = [];
  const seen = new WeakSet<object>();
  const visit = (value: Record<string, unknown>, prefix: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    for (const [name, candidate] of Object.entries(value)) {
      const exportName = `${prefix}${name}`;
      const callable = candidate as FirebaseEndpointFunction;
      if (typeof candidate === 'function' && callable.__endpoint) {
        endpoints.push({ exportName, callable });
      } else if (typeof candidate === 'object' && candidate !== null) {
        visit(candidate as Record<string, unknown>, `${exportName}-`);
      }
    }
  };
  visit(exported, '');
  return endpoints;
}

function normalizePath(path: string): string {
  return path.split('/').filter(Boolean).join('/');
}

function paramName(segment: string): string | null {
  return /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(segment)?.[1] ?? null;
}

function supportsReference(reference: string): boolean {
  return normalizePath(reference).split('/').every((segment) =>
    paramName(segment) !== null || (!segment.includes('{') && !segment.includes('}')),
  );
}

/** Classify unchanged v2 RTDB create exports against the admitted first slice. */
export function inspectOnValueCreated(
  exported: Record<string, unknown>,
): OnValueCreatedInspection {
  const triggers: DiscoveredOnValueCreated[] = [];
  const unsupported: UnsupportedOnValueCreated[] = [];
  for (const { exportName, callable } of listFirebaseEndpoints(exported)) {
    const endpoint = callable.__endpoint;
    const trigger = endpoint?.eventTrigger;
    if (trigger?.eventType !== CREATED_EVENT_TYPE) continue;
    if (endpoint?.omit === true) {
      unsupported.push({
        exportName,
        eventType: `${CREATED_EVENT_TYPE} (omitted from emulation)`,
      });
      continue;
    }
    if (endpoint?.omit !== undefined && endpoint.omit !== false) {
      unsupported.push({
        exportName,
        eventType: `${CREATED_EVENT_TYPE} (unsupported dynamic omit option)`,
      });
      continue;
    }
    const reference = trigger.eventFilterPathPatterns?.ref;
    const exactInstance = trigger.eventFilters?.instance;
    const instancePattern = trigger.eventFilterPathPatterns?.instance;
    if (typeof reference !== 'string') continue;
    if (typeof exactInstance !== 'string' && instancePattern !== '*') {
      if (typeof instancePattern === 'string') {
        unsupported.push({
          exportName,
          eventType: `${CREATED_EVENT_TYPE} (unsupported instance pattern: ${instancePattern})`,
        });
      }
      continue;
    }
    const instance = typeof exactInstance === 'string' ? exactInstance : '*';
    if (!supportsReference(reference)) {
      unsupported.push({
        exportName,
        eventType: `${CREATED_EVENT_TYPE} (unsupported ref pattern: ${reference})`,
      });
      continue;
    }
    const region = endpoint?.region;
    const location = Array.isArray(region) && typeof region[0] === 'string'
      ? region[0]
      : undefined;
    triggers.push({
      exportName,
      reference: normalizePath(reference),
      instance,
      ...(location === undefined ? {} : { location }),
      callable,
    });
  }
  return { triggers, unsupported };
}

export function discoverOnValueCreated(
  exported: Record<string, unknown>,
): DiscoveredOnValueCreated[] {
  return inspectOnValueCreated(exported).triggers;
}
