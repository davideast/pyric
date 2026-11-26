'use client';

/**
 * Subscription and read incident inspection plus programmatic test assertions
 * over a Pyric sandbox or recorded `SandboxEvent` stream.
 *
 * Evaluates the canonical `monitorFirebaseActivity` engine (`duplicate-listener`,
 * `listener-churn`, `repeated-read`) and active listener state so headless
 * component, hook, and data-layer tests in Node, Bun, Vitest, or Jest can
 * verify subscription cleanliness without opening the browser overlay.
 */
import {
  monitorFirebaseActivity,
  type ActivityFeed,
  type ActivityIncident,
  type ActivityPattern,
} from 'pyric/firestore/internal';
import {
  activeListeners,
  type ActiveListener,
  type ActiveListenerTarget,
  type SandboxEvent,
  type SandboxOperationEvent,
} from 'pyric/sandbox';

export type SandboxActivityEventInput =
  | readonly SandboxEvent[]
  | { readonly history: () => readonly SandboxEvent[] };

export interface ActivityIncidentFilterOptions {
  readonly pattern?: ActivityPattern | readonly ActivityPattern[];
  readonly since?: string;
}

export interface ActiveListenerAssertionOptions {
  readonly service?: ActiveListener['service'];
}

export interface SandboxActivityAssertions {
  toHaveNoIncidents(options?: ActivityIncidentFilterOptions): void;
  toHaveActiveListeners(
    target: ActiveListenerTarget,
    expectedCount: number,
    options?: ActiveListenerAssertionOptions,
  ): void;
}

function isEventList(source: SandboxActivityEventInput): source is readonly SandboxEvent[] {
  return Array.isArray(source);
}

function resolveEvents(source: SandboxActivityEventInput): readonly SandboxEvent[] {
  if (isEventList(source)) {
    return source;
  }
  return source.history();
}

function historyFeed(history: readonly SandboxEvent[]): ActivityFeed {
  return {
    history: () => history,
    subscribe: () => () => {},
  };
}

function normalizeEventPath(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  if (path.startsWith('/')) {
    return path.slice(1);
  }
  return path;
}

function matchesOperationTarget(
  cursor: SandboxOperationEvent,
  candidatePath: string | undefined,
): boolean {
  const normalizedCandidate = normalizeEventPath(candidatePath);
  if (normalizedCandidate === undefined) {
    return false;
  }
  if (normalizedCandidate === normalizeEventPath(cursor.path)) {
    return true;
  }
  const rootPath = cursor.detail?.rootPath;
  if (typeof rootPath === 'string' && normalizedCandidate === normalizeEventPath(rootPath)) {
    return true;
  }
  return false;
}

function isCompanionCommit(cursor: SandboxOperationEvent, candidate: SandboxEvent): boolean {
  if (candidate.kind !== 'commit') {
    return false;
  }
  if (candidate.service !== cursor.service || candidate.instance !== cursor.instance) {
    return false;
  }
  if (cursor.groupId !== undefined && candidate.groupId === cursor.groupId) {
    return true;
  }
  return matchesOperationTarget(cursor, candidate.path);
}

function isCompanionMutation(cursor: SandboxOperationEvent, candidate: SandboxEvent): boolean {
  if (candidate.kind !== 'service_mutation') {
    return false;
  }
  if (candidate.service === 'auth') {
    return false;
  }
  if (candidate.service !== cursor.service || candidate.instance !== cursor.instance) {
    return false;
  }
  return matchesOperationTarget(cursor, candidate.path);
}

function eventIdsAfterCursor(events: readonly SandboxEvent[], since: string): Set<string> {
  const at = events.findIndex((event) => event.id === since);
  if (at === -1) {
    throw new Error(
      `Sandbox history does not contain cursor event '${since}'. `
        + 'Omit `since` to inspect all retained events or capture a fresh cursor id.',
    );
  }
  let start = at + 1;
  const cursor = events[at];
  if (cursor !== undefined && cursor.kind === 'operation') {
    const firstTrailing = events[start];
    if (firstTrailing !== undefined && isCompanionCommit(cursor, firstTrailing)) {
      start += 1;
    }
    const nextTrailing = events[start];
    if (nextTrailing !== undefined && isCompanionMutation(cursor, nextTrailing)) {
      start += 1;
    }
  }
  return new Set(events.slice(start).map((event) => event.id));
}

function matchesPatternFilter(
  incident: ActivityIncident,
  filter: ActivityPattern | readonly ActivityPattern[] | undefined,
): boolean {
  if (filter === undefined) {
    return true;
  }
  if (typeof filter === 'string') {
    return incident.pattern === filter;
  }
  return filter.includes(incident.pattern);
}

/** Decode a public listener incident fingerprint into an ActiveListenerTarget, or null. */
export function decodeActivityIncidentTarget(targetFingerprint: string): ActiveListenerTarget | null {
  if (!targetFingerprint.startsWith('{')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(targetFingerprint);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind === 'doc' && typeof record.path === 'string' && record.path.length > 0) {
      return record.path;
    }
    if (record.kind === 'query' && typeof record.collection === 'string' && record.collection.length > 0) {
      return { collection: record.collection, query: true };
    }
  } catch {
    /* Non-JSON or truncated fingerprints do not map to a structured listener target. */
  }
  return null;
}

/** Format an ActivityIncident targetFingerprint as a concise path or query label. */
export function formatActivityIncidentTargetLabel(targetFingerprint: string): string {
  if (!targetFingerprint.startsWith('{')) {
    return targetFingerprint;
  }
  try {
    const parsed: unknown = JSON.parse(targetFingerprint);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return targetFingerprint;
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind === 'doc' && typeof record.path === 'string' && record.path.length > 0) {
      return record.path;
    }
    if (record.kind === 'query' && typeof record.collection === 'string' && record.collection.length > 0) {
      if (typeof record.query === 'string' && record.query.length > 0) {
        return `${record.collection} (query ${record.query})`;
      }
      return `${record.collection} (query)`;
    }
  } catch {
    /* Malformed JSON falls back to the raw fingerprint string. */
  }
  return targetFingerprint;
}

/** Run the Firebase activity monitor over a sandbox or event list and filter matching incidents. */
export function collectActivityIncidents(
  source: SandboxActivityEventInput,
  options?: ActivityIncidentFilterOptions,
): readonly ActivityIncident[] {
  const history = resolveEvents(source);
  let activeIds: Set<string> | null = null;
  if (options?.since !== undefined) {
    activeIds = eventIdsAfterCursor(history, options.since);
  }
  const monitor = monitorFirebaseActivity(historyFeed(history), () => {});
  let incidents: readonly ActivityIncident[];
  try {
    incidents = monitor.report().incidents;
  } finally {
    monitor.dispose();
  }
  return incidents.filter((incident) => {
    if (!matchesPatternFilter(incident, options?.pattern)) {
      return false;
    }
    if (activeIds !== null) {
      const windowIds = activeIds;
      return incident.evidenceEventIds.some((id) => windowIds.has(id));
    }
    return true;
  });
}

function formatIncidentDiagnosticLine(incident: ActivityIncident): string {
  const target = formatActivityIncidentTargetLabel(incident.targetFingerprint);
  const evidence = incident.evidenceEventIds.join(', ');
  let detail = `count=${incident.count}, window=${incident.windowMs}ms`;
  if (incident.listenerBalance !== undefined) {
    const balance = incident.listenerBalance;
    detail = `attaches=${balance.attaches}, detaches=${balance.detaches}, active=${balance.active}, window=${incident.windowMs}ms`;
  }
  return `- [${incident.pattern}] target='${target}' source='${incident.sourceAttribution}' (${detail}) evidence=[${evidence}]`;
}

/** Assert that zero matching Firebase activity incidents occurred in the sandbox history. */
export function assertNoActivityIncidents(
  source: SandboxActivityEventInput,
  options?: ActivityIncidentFilterOptions,
): void {
  const incidents = collectActivityIncidents(source, options);
  if (incidents.length === 0) {
    return;
  }
  const lines = incidents.map(formatIncidentDiagnosticLine);
  throw new Error(
    `Expected 0 Firebase activity incidents, found ${incidents.length}:\n${lines.join('\n')}`,
  );
}

function listenerTargetsMatch(a: ActiveListenerTarget, b: ActiveListenerTarget): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return normalizeEventPath(a) === normalizeEventPath(b);
  }
  if (typeof a === 'string' || typeof b === 'string') {
    return false;
  }
  return normalizeEventPath(a.collection) === normalizeEventPath(b.collection);
}

function formatListenerTarget(target: ActiveListenerTarget): string {
  if (typeof target === 'string') {
    return target;
  }
  return `${target.collection} (query)`;
}

/** Assert the exact number of currently attached listeners on a document or query target. */
export function assertActiveListeners(
  source: SandboxActivityEventInput,
  target: ActiveListenerTarget,
  expectedCount: number,
  options?: ActiveListenerAssertionOptions,
): void {
  const history = resolveEvents(source);
  const attached = activeListeners(history).filter((listener) => {
    if (options?.service !== undefined && listener.service !== options.service) {
      return false;
    }
    return listenerTargetsMatch(listener.target, target);
  });
  if (attached.length === expectedCount) {
    return;
  }
  const ids = attached.map((listener) => listener.id).join(', ');
  let idSuffix = '';
  if (ids.length > 0) {
    idSuffix = ` ([${ids}])`;
  }
  throw new Error(
    `Expected ${expectedCount} active listener(s) on '${formatListenerTarget(target)}', `
      + `found ${attached.length}${idSuffix}.`,
  );
}

/** Chainable test assertion helper over a Pyric sandbox or recorded event list. */
export function expectSandboxActivity(source: SandboxActivityEventInput): SandboxActivityAssertions {
  return {
    toHaveNoIncidents(options?: ActivityIncidentFilterOptions): void {
      assertNoActivityIncidents(source, options);
    },
    toHaveActiveListeners(
      target: ActiveListenerTarget,
      expectedCount: number,
      options?: ActiveListenerAssertionOptions,
    ): void {
      assertActiveListeners(source, target, expectedCount, options);
    },
  };
}
