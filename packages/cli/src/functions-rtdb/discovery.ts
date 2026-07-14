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

function normalizePath(path: string): string {
  return path.split('/').filter(Boolean).join('/');
}

function pathParts(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized ? normalized.split('/') : [];
}

function paramName(segment: string): string | null {
  return /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(segment)?.[1] ?? null;
}

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

export function discoverOnValueCreated(
  exported: Record<string, unknown>,
): DiscoveredOnValueCreated[] {
  return inspectOnValueCreated(exported).triggers;
}
