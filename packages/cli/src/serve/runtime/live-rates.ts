/**
 * Rates on a live host, read from the host's event stream instead of the
 * page's SDK journal: every call production served and a client observed
 * (this page, other tabs, Node processes) counts, with production's sizes.
 *
 * Firestore, RTDB and Storage come from here. AI keeps its own seam
 * (`worker-ai-rates.ts` over the host's AI rows), so an AI call counts once,
 * through its tokens, and never through `production.usage`.
 */
import type { SandboxEvent, SandboxOperationEvent } from 'pyric/sandbox';
import {
  createSdkRates, eventScope, isProductionServed, sdkMethodCoverage,
  type EventScope, type SdkObservation, type SdkRateSnapshot, type SdkServiceRate, type UsageEvidence,
} from 'pyric/sandbox/internal';

const LIVE_SERVICES = ['firestore', 'rtdb', 'storage'] as const;
type LiveService = typeof LIVE_SERVICES[number];
type Category = 'read' | 'write' | 'listener';
type Phase = 'start' | 'delivery' | 'end';

/** The page's wall clock and the monotonic clock its rate windows use. */
export interface LiveRatesClock {
  now(): number;
  monotonicNow(): number;
}

const PAGE_CLOCK: LiveRatesClock = { now: () => Date.now(), monotonicNow: () => performance.now() };

/** Ties at one instant keep the SDK's order: a call starts, delivers, then ends. */
const PHASE_ORDER: Readonly<Record<Phase, number>> = { start: 0, delivery: 1, end: 2 };

interface ObservedPhase {
  at: number;
  phase: Phase;
  event: SandboxOperationEvent & { service: LiveService };
  category: Category;
  usage?: UsageEvidence;
}

function isLiveService(service: string): service is LiveService {
  return (LIVE_SERVICES as readonly string[]).includes(service);
}

/** A Firestore, RTDB or Storage call production served, as the host recorded it. */
function isObservedLiveCall(event: SandboxEvent): event is SandboxOperationEvent & { service: LiveService } {
  const isOperation = event.kind === 'operation';
  if (!isOperation) return false;
  const servedByProduction = event.production !== undefined && isProductionServed(event.rulesDisposition);
  return servedByProduction && isLiveService(event.service);
}

/**
 * The coverage method an observed call counts as. The live row records a
 * batch commit as `writeBatch` (its export); Rates count it on the sandbox's
 * `writeBatch.commit` write entry.
 */
const COVERAGE_ALIASES: ReadonlyMap<string, string> = new Map([['firestore/writeBatch', 'writeBatch.commit']]);

function coverageMethod(service: LiveService, method: string): string {
  return COVERAGE_ALIASES.get(`${service}/${method}`) ?? method;
}

function categoryOf(service: LiveService, method: string): Category | undefined {
  const covered = coverageMethod(service, method);
  return sdkMethodCoverage(service).find(entry => entry.method === covered)?.category;
}

/** `usage: {}` names nothing, so it reads as missing. */
function measuredUsage(event: SandboxOperationEvent): UsageEvidence | undefined {
  const usage = event.production?.usage;
  if (usage === undefined) return undefined;
  const names = Object.values(usage).some(value => value !== undefined);
  return names ? { ...usage } : undefined;
}

/**
 * What a successful call was billed for or moved: a Firestore delivery's
 * billed documents, else the recorder's usage, else one unmeasured part.
 * A failed call has none.
 */
function usageOf(event: SandboxOperationEvent, category: Category): UsageEvidence | undefined {
  const succeeded = event.production?.outcome.status === 'ok';
  if (!succeeded) return undefined;
  const usage = measuredUsage(event);
  const billedDocuments = event.production?.billedDocuments;
  const isFirestoreDelivery = category === 'listener' && event.service === 'firestore' && billedDocuments !== undefined;
  if (isFirestoreDelivery) return { ...usage, documentReads: billedDocuments };
  return usage ?? { unmeasured: 1 };
}

/**
 * The phases one observed call stands for. A listener event is one delivery.
 * A one-shot call starts at `at` and settles when production answered: a
 * read delivers its result then ends, a write ends with what it wrote.
 */
function phasesOf(event: SandboxOperationEvent & { service: LiveService }): ObservedPhase[] {
  const category = categoryOf(event.service, event.method);
  if (category === undefined) return [];
  const usage = usageOf(event, category);
  const measured = usage === undefined ? {} : { usage };
  if (category === 'listener') return [{ at: event.at, phase: 'delivery', event, category, ...measured }];
  const answeredAt = event.at + (event.durationMs ?? 0);
  const start: ObservedPhase = { at: event.at, phase: 'start', event, category };
  const isRead = category === 'read';
  const succeeded = event.production?.outcome.status === 'ok';
  if (isRead && succeeded) {
    return [start, { at: answeredAt, phase: 'delivery', event, category, ...measured }, { at: answeredAt, phase: 'end', event, category }];
  }
  return [start, { at: answeredAt, phase: 'end', event, category, ...measured }];
}

function observedPhases(events: readonly SandboxEvent[], scope: EventScope): ObservedPhase[] {
  const seen = new Set<string>();
  const phases: ObservedPhase[] = [];
  for (const event of events) {
    const isRepeat = seen.has(event.id);
    if (isRepeat || !isObservedLiveCall(event)) continue;
    if (!eventScope(event, scope)) continue;
    seen.add(event.id);
    phases.push(...phasesOf(event));
  }
  return phases.sort((a, b) => a.at - b.at || PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]);
}

function statusOf(entry: ObservedPhase): SdkObservation['status'] {
  if (entry.category === 'listener') return 'active';
  if (entry.phase !== 'end') return 'pending';
  return entry.event.production?.outcome.status === 'ok' ? 'completed' : 'failed';
}

function observationOf(entry: ObservedPhase, sequence: number, offset: number): SdkObservation {
  const { event, phase, at } = entry;
  const usage = entry.usage === undefined ? {} : { usage: entry.usage };
  return {
    ...usage, sequence, id: `${event.id}/${phase}`, activityId: event.id, appId: 'host', sourceId: event.id,
    service: event.service, method: coverageMethod(event.service, event.method),
    kind: entry.category === 'listener' ? 'subscription' : 'operation',
    phase, status: statusOf(entry), at, monotonicAt: at - offset,
    deliveryNumber: phase === 'delivery' ? 1 : 0,
  };
}

/**
 * Rebuilds Firestore, RTDB and Storage rates from the host's observed calls,
 * deduplicated by event id so a replayed batch cannot count twice. Returns
 * the overlay a page's snapshot passes through, in place of the journal's
 * counts for those services. `scope` keeps one client's or one user's calls
 * (`eventScope`); the chip reads every client until a scope control ships.
 */
export function liveRates(events: readonly SandboxEvent[], clock: LiveRatesClock = PAGE_CLOCK, scope: EventScope = 'all') {
  const offset = clock.now() - clock.monotonicNow();
  const phases = observedPhases(events, scope);
  const rates = createSdkRates({ monotonicNow: () => clock.monotonicNow() });
  let sequence = 0;
  for (const entry of phases) rates.record(observationOf(entry, ++sequence, offset));
  const first = phases[0];
  const firstSecond = first === undefined ? undefined : Math.floor((first.at - offset) / 1000);
  const withStart = (service: SdkServiceRate): SdkServiceRate => {
    const history = service.history;
    const keepsStart = history === undefined || firstSecond === undefined;
    if (keepsStart) return service;
    return { ...service, history: { ...history, startedSecond: Math.min(history.startedSecond, firstSecond) } };
  };
  return (snapshot: SdkRateSnapshot): SdkRateSnapshot => {
    const host = new Map(rates.snapshot().services.map(service => [service.service, service]));
    const services = snapshot.services.map(service => {
      const live = isLiveService(service.service) ? host.get(service.service) : undefined;
      return live === undefined ? service : withStart(live);
    });
    return { ...snapshot, services };
  };
}
