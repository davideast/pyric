/**
 * The Firebase endpoints a Functions source exports, read the way the
 * Firebase loader reads them: every exported function that carries an
 * `__endpoint` manifest, under the hyphenated name its export path gives it.
 *
 * Every trigger family starts here. A family claims the endpoints whose
 * trigger it serves and leaves the rest to `unsupported.ts`.
 */

/** The manifest the Firebase Functions SDK attaches to every endpoint. */
export interface FirebaseEndpoint {
  omit?: unknown;
  region?: unknown;
  platform?: unknown;
  timeoutSeconds?: unknown;
  eventTrigger?: {
    eventType?: unknown;
    eventFilters?: Record<string, unknown>;
    eventFilterPathPatterns?: Record<string, unknown>;
  };
  callableTrigger?: unknown;
  httpsTrigger?: { invoker?: unknown } | null;
  scheduleTrigger?: unknown;
  taskQueueTrigger?: unknown;
}

/** Any exported function; a family narrows it to the handler shape it calls. */
export type EndpointCallable = (...args: never[]) => unknown;

export type FirebaseEndpointFunction<F = EndpointCallable> = F & {
  __endpoint?: FirebaseEndpoint;
};

export interface ListedEndpoint<F = EndpointCallable> {
  exportName: string;
  callable: FirebaseEndpointFunction<F>;
}

/** Walk exports using the same hyphenated nested names as Firebase's loader. */
export function listFirebaseEndpoints<F = EndpointCallable>(
  exported: Record<string, unknown>,
): Array<ListedEndpoint<F>> {
  const endpoints: Array<ListedEndpoint<F>> = [];
  const visit = (
    value: Record<string, unknown>,
    prefix: string,
    ancestors: ReadonlySet<object>,
  ): void => {
    if (ancestors.has(value)) return;
    const nestedAncestors = new Set(ancestors).add(value);
    for (const [name, candidate] of Object.entries(value)) {
      const exportName = `${prefix}${name}`;
      const callable = candidate as FirebaseEndpointFunction<F>;
      if (typeof candidate === 'function' && callable.__endpoint) {
        endpoints.push({ exportName, callable });
      } else if (typeof candidate === 'object' && candidate !== null) {
        visit(candidate as Record<string, unknown>, `${exportName}-`, nestedAncestors);
      }
    }
  };
  visit(exported, '', new Set());
  return endpoints;
}

/** The manifest field each non-event trigger kind sets, and the label it reports under. */
const TRIGGER_LABELS: ReadonlyArray<readonly [keyof FirebaseEndpoint, string]> = [
  ['callableTrigger', 'callable'],
  ['httpsTrigger', 'https'],
  ['scheduleTrigger', 'schedule'],
  ['taskQueueTrigger', 'task-queue'],
];

/**
 * The label an endpoint reports when no family serves it: its event type for
 * an event trigger, otherwise the kind of trigger its manifest declares.
 */
export function endpointTriggerLabel(endpoint: FirebaseEndpoint): string {
  const eventType = endpoint.eventTrigger?.eventType;
  if (typeof eventType === 'string') return eventType;
  const declared = TRIGGER_LABELS.find(([field]) => endpoint[field] !== undefined);
  return declared?.[1] ?? 'unknown';
}
