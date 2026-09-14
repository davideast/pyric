import type { EventService } from '../types/operation.js';
import { firestoreActivityCoverage } from '../../firestore/activity-coverage.js';
import { databaseActivityCoverage } from '../../database/activity-coverage.js';

export type SdkMethodCategory = 'read' | 'write' | 'listener';
export interface SdkMethodCoverage {
  readonly method: string;
  readonly category: SdkMethodCategory;
}
// Statically aggregate only service-owned data, never import service executors.
// This keeps the foundation usable before SDK construction and prevents cycles.
const services = [firestoreActivityCoverage, databaseActivityCoverage];
const methods = new Map<EventService, readonly SdkMethodCoverage[]>();
const untracked = new Map<EventService, readonly string[]>();
for (const service of services) {
  methods.set(service.service, Object.freeze((['read', 'write', 'listener'] as const).flatMap(category =>
    service[category].map(method => Object.freeze({ method, category })))));
  untracked.set(service.service, Object.freeze([...service.untrackedMethods]));
}
const empty = Object.freeze([]);
/** Explicit public data-operation coverage, not a claim about every SDK API. */
export function sdkMethodCoverage(service: EventService): readonly SdkMethodCoverage[] {
  return methods.get(service) ?? empty;
}
export function sdkUntrackedMethods(service: EventService): readonly string[] {
  return untracked.get(service) ?? empty;
}
