/**
 * Coverage accounting for `sandbox.activity`.
 *
 * The activity monitor only inspects Firestore reads and listeners. Any other
 * service that emits events in the inspected window must be surfaced explicitly
 * so an empty incident list never reads as a clean result for services the
 * monitor did not inspect.
 */
import type { EventService, SandboxEvent } from 'pyric/sandbox';

const EXAMINED_SERVICES = ['firestore'] as const;

export interface ActivityCoverage {
  readonly examined: readonly ['firestore'];
  readonly notExamined: ReadonlyArray<{
    readonly service: Exclude<EventService, 'firestore'>;
    readonly eventCount: number;
    readonly listenerEventCount: number;
  }>;
}

type UnexaminedServiceActivity = ActivityCoverage['notExamined'][number];

function serviceOfEvent(event: SandboxEvent): EventService | null {
  switch (event.kind) {
    case 'session_boundary':
    case 'observation_gap':
      return null;
    case 'operation':
    case 'commit':
    case 'listener':
    case 'service_mutation':
    case 'runtime_error':
      return event.service;
    case 'request':
    case 'write':
    case 'snapshot_delivery':
    case 'snapshot_suppressed':
    case 'listener_attach':
    case 'listener_detach':
    case 'listener_errored':
      return event.service ?? 'firestore';
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function isListenerEvent(event: SandboxEvent): boolean {
  switch (event.kind) {
    case 'listener':
    case 'listener_attach':
    case 'listener_detach':
    case 'listener_errored':
    case 'snapshot_delivery':
    case 'snapshot_suppressed':
      return true;
    case 'request':
    case 'write':
    case 'operation':
    case 'commit':
    case 'service_mutation':
    case 'runtime_error':
    case 'session_boundary':
    case 'observation_gap':
      return false;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function isExaminedService(service: EventService): service is 'firestore' {
  return service === 'firestore';
}

function formatUnexaminedEntry(entry: UnexaminedServiceActivity): string {
  if (entry.listenerEventCount === 0) {
    return `${entry.eventCount} ${entry.service} event(s)`;
  }
  if (entry.listenerEventCount === entry.eventCount) {
    return `${entry.listenerEventCount} ${entry.service} listener event(s)`;
  }
  return `${entry.eventCount} ${entry.service} event(s) (${entry.listenerEventCount} listener)`;
}

/** Count unexamined service events in the inspected window, sorted by service name. */
export function summarizeActivityCoverage(events: readonly SandboxEvent[]): ActivityCoverage {
  const counts = new Map<
    Exclude<EventService, 'firestore'>,
    { eventCount: number; listenerEventCount: number }
  >();

  for (const event of events) {
    const service = serviceOfEvent(event);
    if (service === null || isExaminedService(service)) continue;

    let entry = counts.get(service);
    if (entry === undefined) {
      entry = { eventCount: 0, listenerEventCount: 0 };
      counts.set(service, entry);
    }
    entry.eventCount += 1;
    if (isListenerEvent(event)) {
      entry.listenerEventCount += 1;
    }
  }

  const notExamined: UnexaminedServiceActivity[] = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([service, count]) => ({
      service,
      eventCount: count.eventCount,
      listenerEventCount: count.listenerEventCount,
    }));

  return {
    examined: [...EXAMINED_SERVICES],
    notExamined,
  };
}

/** Format the activity summary with explicit service coverage. */
export function formatActivitySummary(
  incidentCount: number,
  coverage: ActivityCoverage,
): string {
  const scope = `Examined ${coverage.examined.join(', ')} only`;
  if (coverage.notExamined.length === 0) {
    return `${incidentCount} incident(s). ${scope}.`;
  }
  const omitted = coverage.notExamined.map(formatUnexaminedEntry).join(', ');
  return `${incidentCount} incident(s). ${scope}; ${omitted} not examined.`;
}
