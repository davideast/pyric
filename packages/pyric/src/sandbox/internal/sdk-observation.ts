import type { EventService } from '../types/operation.js';
import type { SdkActivityEvent, SdkActivityRecord } from './sdk-activity.js';

/** SDK adapters use `database`; sandbox operation records use `rtdb`. */
export function observationService(service: EventService | 'database'): EventService {
  if (service === 'database') return 'rtdb';
  return service;
}

/** Public SDK evidence only. No results, credentials, query values or DOM owners. */
export interface SdkObservation {
  /** Unique within this journal session, including repeated listener deliveries. */
  readonly id: string;
  readonly activityId: string;
  readonly appId: string;
  /** A retained source identity, not a permanent metric-series identifier. */
  readonly sourceId: string;
  readonly service: EventService;
  readonly method: string;
  readonly kind: SdkActivityRecord['kind'];
  readonly status: SdkActivityRecord['status'];
  /** `remove` releases retained state. It is never a call or delivery. */
  readonly phase: Exclude<SdkActivityEvent['phase'], 'transport'>;
  readonly deliveryNumber: number;
  /** Wall-clock observation time for display. */
  readonly at: number;
  /** Monotonic observation time for rate windows, local to this realm. */
  readonly monotonicAt: number;
}

export function sdkObservation(
  event: SdkActivityEvent,
  at: number,
  monotonicAt: number,
): SdkObservation | undefined {
  if (event.phase === 'transport') return undefined;
  const { record, phase } = event;
  return Object.freeze({
    id: `${record.id}/${phase}/${record.deliveryCount}`,
    activityId: record.id,
    appId: record.appId,
    sourceId: record.sourceId,
    service: observationService(record.service),
    method: record.method,
    kind: record.kind,
    status: record.status,
    phase,
    deliveryNumber: record.deliveryCount,
    at,
    monotonicAt,
  });
}
