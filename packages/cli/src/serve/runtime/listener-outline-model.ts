/**
 * What the chip's Listeners mode draws: one outline record per listener the
 * sandbox currently holds attached, derived from the same event stream the
 * page already receives.
 *
 * The model is pure. It reads the active-listener fold for lifecycle, targets,
 * and delivery counts, reads listener attribution for the label and the
 * geometry, and reads the activity monitor's incidents for the badge mark. The
 * overlay that paints these records owns no derivation of its own.
 */
import { createActiveListenerState } from 'pyric/sandbox/internal';
import { activeListeners, type ActiveListener, type ActiveListenerTarget } from 'pyric/sandbox';
import type { SandboxEvent } from 'pyric/sandbox';
import type { ActivityIncident } from 'pyric/firestore/internal';
import type { SdkActivityRecord } from 'pyric/sandbox/internal';

/**
 * A `component` owner names the React or framework component that created the
 * listener. It is the most specific attribution there is, so it wins both the
 * label and the geometry when an emitter recorded one. The owner union is
 * declared alongside the events it travels on and may not carry this member
 * yet, so the chip reads it structurally rather than by the union's name.
 */
interface ComponentOwner {
  readonly kind: 'component';
  readonly name: string;
  readonly path?: string;
  readonly element?: string;
}

interface TagOwner {
  readonly kind: 'tag';
  readonly name: string;
  readonly element?: string;
}

interface FrameOwner {
  readonly kind: 'frame';
  readonly file: string;
  readonly line: number;
  readonly function?: string;
}

interface RegionsOwner {
  readonly kind: 'regions';
  readonly selectors: readonly string[];
}

/** The incident mark a badge carries, when the listener is part of one. */
export interface ListenerOutlineIncident {
  readonly pattern: 'duplicate-listener' | 'listener-churn';
  readonly count: number;
  /** The window the count was measured over, in milliseconds. */
  readonly windowMs: number;
}

/** One listener as the overlay draws it. */
export interface ListenerOutline {
  readonly colorKey?: string;
  readonly activity?: SdkActivityRecord;
  readonly observedRender?: boolean;
  readonly listenerId: string;
  /** The page client's own subscription id, when the attach carried it; a
   * delivery observed on the page names the listener by this id. */
  readonly clientListenerId?: string;
  /** Component name, else owner tag name, else creating function or file. */
  readonly label: string;
  /**
   * `true` when `label` names an owner the app itself gave (a component or a
   * tag). `false` means the label fell back to a frame's function or file
   * name, or to the listener id, none of which the app wrote.
   */
  readonly labelIsOwner: boolean;
  /** Collection path for a query, document or node path otherwise. */
  readonly target: string;
  readonly isQuery: boolean;
  readonly service: 'firestore' | 'database' | 'storage' | 'ai';
  readonly deliveryCount: number;
  /** When this listener last handed the application a snapshot, when it has. */
  readonly lastDeliveryAt?: number;
  /** Selectors to outline. Empty when nothing on the page could be found. */
  readonly selectors: readonly string[];
  readonly incident: ListenerOutlineIncident | null;
}

/** Public SDK activity takes precedence over its matching backend registration. */
export function activityOutlines(
  legacy: readonly ListenerOutline[],
  records: readonly SdkActivityRecord[],
  observed: ReadonlySet<string>,
): readonly ListenerOutline[] {
  const ids = new Set(records.flatMap(record => [record.id, record.transportId]));
  const unmatched = legacy.filter(outline => !ids.has(outline.clientListenerId ?? outline.listenerId));
  return [...unmatched, ...records.map(record => {
    const backend = legacy.find(outline => outline.clientListenerId === (record.transportId ?? record.id));
    const owners = record.owners;
    return {
      listenerId: record.id, clientListenerId: record.transportId,
      label: outlineLabel(owners, record.method), labelIsOwner: labelIsOwner(owners),
      target: record.target, isQuery: record.isQuery, service: record.service,
      deliveryCount: record.deliveryCount, lastDeliveryAt: record.lastProgressAt === undefined ? record.lastDeliveryAt : Math.max(record.lastDeliveryAt ?? 0, record.lastProgressAt),
      selectors: outlineSelectors(owners), incident: backend?.incident ?? null,
      activity: record, observedRender: observed.has(record.id),
    };
  })];
}

function componentOwner(owners: readonly unknown[]): ComponentOwner | null {
  for (const owner of owners) {
    const candidate = owner as ComponentOwner;
    if (candidate?.kind === 'component' && typeof candidate.name === 'string') return candidate;
  }
  return null;
}

function tagOwner(owners: readonly unknown[]): TagOwner | null {
  for (const owner of owners) {
    const candidate = owner as TagOwner;
    if (candidate?.kind === 'tag') return candidate;
  }
  return null;
}

function frameOwner(owners: readonly unknown[]): FrameOwner | null {
  for (const owner of owners) {
    const candidate = owner as FrameOwner;
    if (candidate?.kind === 'frame') return candidate;
  }
  return null;
}

function regionSelectors(owners: readonly unknown[]): readonly string[] {
  for (const owner of owners) {
    const candidate = owner as RegionsOwner;
    if (candidate?.kind === 'regions' && Array.isArray(candidate.selectors)) return candidate.selectors;
  }
  return [];
}

/** The label, most specific attribution first. */
function outlineLabel(owners: readonly unknown[], listenerId: string): string {
  const component = componentOwner(owners);
  if (component !== null) return component.name;
  const tag = tagOwner(owners);
  if (tag !== null) return tag.name;
  const frame = frameOwner(owners);
  if (frame === null) return listenerId;
  if (typeof frame.function === 'string' && frame.function.length > 0) return frame.function;
  return frame.file;
}

/**
 * `true` when the label the app would see names an owner it gave itself (a
 * component or a tag), rather than a frame's function or file name, or the
 * listener id, both of which describe the sandbox's own bundle rather than
 * anything the app wrote.
 */
function labelIsOwner(owners: readonly unknown[]): boolean {
  return componentOwner(owners) !== null || tagOwner(owners) !== null;
}

/** The geometry, most specific owner first, then the latest delivery's regions. */
export function outlineSelectors(owners: readonly unknown[]): readonly string[] {
  const component = componentOwner(owners);
  if (component !== null && typeof component.element === 'string') return [component.element];
  const tag = tagOwner(owners);
  if (tag !== null && typeof tag.element === 'string') return [tag.element];
  return regionSelectors(owners);
}

function targetPath(target: ActiveListenerTarget): string {
  if (typeof target === 'string') return target;
  return target.collection;
}

function targetIsQuery(target: ActiveListenerTarget): boolean {
  return typeof target !== 'string';
}

/**
 * The event id of each listener's most recent attach, keyed by listener id.
 * The activity monitor cites attach events as an incident's evidence, so this
 * is how a listener is matched back to the incident it is part of.
 */
function latestAttachEventIds(events: readonly SandboxEvent[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const event of events) {
    const candidate = event as { kind: string; id: string; listenerId?: string; phase?: string };
    const isFirestoreAttach = candidate.kind === 'listener_attach';
    const isCanonicalAttach = candidate.kind === 'listener' && candidate.phase === 'attach';
    if (!isFirestoreAttach && !isCanonicalAttach) continue;
    if (typeof candidate.listenerId !== 'string') continue;
    ids.set(candidate.listenerId, candidate.id);
  }
  return ids;
}

function incidentMark(
  incidents: readonly ActivityIncident[],
  attachEventId: string | undefined,
): ListenerOutlineIncident | null {
  if (attachEventId === undefined) return null;
  for (const incident of incidents) {
    const isListenerPattern = incident.pattern === 'duplicate-listener' || incident.pattern === 'listener-churn';
    if (!isListenerPattern) continue;
    if (!incident.evidenceEventIds.includes(attachEventId)) continue;
    return { pattern: incident.pattern, count: incident.count, windowMs: incident.windowMs };
  }
  return null;
}

function outlineFor(
  listener: ActiveListener,
  attachEventIds: Map<string, string>,
  incidents: readonly ActivityIncident[],
): ListenerOutline {
  const owners = listener.owners ?? [];
  return {
    listenerId: listener.id,
    ...(listener.clientListenerId === undefined ? {} : { clientListenerId: listener.clientListenerId }),
    label: outlineLabel(owners, listener.id),
    labelIsOwner: labelIsOwner(owners),
    target: targetPath(listener.target),
    isQuery: targetIsQuery(listener.target),
    service: listener.service,
    deliveryCount: listener.deliveryCount,
    ...(listener.lastDeliveryAt === undefined ? {} : { lastDeliveryAt: listener.lastDeliveryAt }),
    selectors: outlineSelectors(owners),
    incident: incidentMark(incidents, attachEventIds.get(listener.id)),
  };
}

/** Every currently attached listener, as the overlay draws it. */
export function listenerOutlines(
  events: readonly SandboxEvent[],
  incidents: readonly ActivityIncident[],
): readonly ListenerOutline[] {
  const attachEventIds = latestAttachEventIds(events);
  return activeListeners(events).map((listener) => outlineFor(listener, attachEventIds, incidents));
}

/** Current listener state, independent of how much history the page has seen. */
export function createListenerOutlineState() {
  const listeners = createActiveListenerState();
  const attachEventIds = new Map<string, string>();
  return {
    append(events: readonly SandboxEvent[]) {
      for (const event of events) listeners.append(event);
      for (const [id, eventId] of latestAttachEventIds(events)) attachEventIds.set(id, eventId);
    },
    read(incidents: readonly ActivityIncident[]): readonly ListenerOutline[] {
      const active = listeners.snapshot();
      const activeIds = new Set(active.map(listener => listener.id));
      for (const id of attachEventIds.keys()) {
        const detached = !activeIds.has(id);
        if (detached) attachEventIds.delete(id);
      }
      return active.map(listener => outlineFor(listener, attachEventIds, incidents));
    },
    clear() {
      listeners.clear();
      attachEventIds.clear();
    },
  };
}
