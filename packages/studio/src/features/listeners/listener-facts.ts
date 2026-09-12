/**
 * The facts the Listeners surfaces state (feature: Listeners).
 *
 * PURE. Every line on these surfaces is values separated by ` · `, so this
 * module is the one place that phrasing lives: the headline over the tab, the
 * owner line under it, the fact line on a listener, the incident line over a
 * duplicate, and one delivery's figures.
 *
 * No line explains itself. `How this is counted` in the footer is where the
 * method is written down; a line here states what happened and stops.
 */

import type { ActivityIncident } from 'pyric/firestore/internal';
import type { ActiveListener } from 'pyric/sandbox';
import { formatAgo, formatDuration } from './listener-vocabulary.js';

/** What the tab's headline and owner line are folded from. */
export interface ListenerFold {
  /** Listeners attached right now, after the view's filters. */
  readonly listeners: number;
  /** One entry per target attached more than once: how many times. */
  readonly duplicates: readonly number[];
  /** Listener-churn incidents raised over these listeners. */
  readonly churn: number;
  /** The owner holding the most listeners. */
  readonly busiest?: { readonly label: string; readonly count: number };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** How many times something attached: `twice`, else `5 times`. */
export function attachedTimes(count: number): string {
  return count === 2 ? 'twice' : `${count} times`;
}

/** The service as the word the reader uses, not the event's token. */
export function serviceWord(service: ActiveListener['service']): string {
  return service === 'firestore' ? 'Firestore' : 'Database';
}

/** The tab's headline: how many listeners, and what is wrong with them. */
export function listenerHeadline(fold: ListenerFold): string {
  if (fold.listeners === 0) return 'No listeners attached';
  const attached = plural(fold.listeners, 'listener');
  if (fold.duplicates.length > 0) {
    const most = Math.max(...fold.duplicates);
    return `${attached}, ${fold.duplicates.length} attached ${attachedTimes(most)}`;
  }
  if (fold.churn > 0) return `${attached}, ${plural(fold.churn, 'listener')} reattaching`;
  return attached;
}

/** The owner holding more than one listener, and how many. Nothing when no
 *  owner holds more than one: a line per owner would be the list again. */
export function listenerOwnerFact(fold: ListenerFold): string | undefined {
  const busiest = fold.busiest;
  if (busiest === undefined || busiest.count < 2) return undefined;
  return `${busiest.label} · ${plural(busiest.count, 'listener')}`;
}

/** One listener's fact line: who holds it, what it paints, which backend
 *  answers it, how long it has been attached. */
export function listenerFactLine(
  facts: {
    readonly owner?: string;
    readonly element?: string;
    readonly service: ActiveListener['service'];
    readonly attachedAt: number;
  },
  now: number,
): string {
  const parts: string[] = [];
  if (facts.owner !== undefined) parts.push(facts.owner);
  if (facts.element !== undefined) parts.push(facts.element);
  parts.push(serviceWord(facts.service));
  parts.push(`attached ${formatAgo(facts.attachedAt, now)}`);
  return parts.join(' · ');
}

/** The attach ages an incident line ends with: `24m ago and 20s ago`. */
export function attachAgesLine(ages: readonly string[]): string {
  if (ages.length < 2) return ages.join('');
  return `${ages.slice(0, -1).join(', ')} and ${ages[ages.length - 1]!}`;
}

/**
 * The incident line over a listener: what happened, who held it, and when.
 * A duplicate names every attach's age; churn carries its count and window
 * instead, since forty ages are not readable and the count is the fact.
 */
export function incidentLine(
  incident: ActivityIncident,
  owner: string | undefined,
  ages: readonly string[],
): string {
  const by = owner === undefined ? '' : ` by ${owner}`;
  if (incident.pattern === 'listener-churn') {
    return `Reattached ${incident.count} times in ${formatDuration(incident.windowMs)}${by}`;
  }
  const when = attachAgesLine(ages);
  const attached = `Attached ${attachedTimes(incident.count)}${by}`;
  return when === '' ? attached : `${attached} · ${when}`;
}
