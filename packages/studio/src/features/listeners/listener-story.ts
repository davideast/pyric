/**
 * The Listeners journal header's two sentences (feature: Listeners).
 *
 * PURE, the way `traffic/metric-story.ts` is pure for the Billable metrics
 * panel: the fold hands over counts, this module turns them into the
 * headline and the finding. Nothing here reads an event or a clock.
 *
 * The headline states how many listeners are attached, and names an incident
 * when one exists, because "is anything wrong" is the first question. The
 * finding carries the next most useful fact: who holds the most listeners,
 * then the incident detail, or the absence of incidents together with how
 * many listeners have gone quiet.
 */

/** One duplicate incident, reduced to what the sentence needs. */
export interface DuplicateFact {
  readonly target: string;
  readonly count: number;
}

/** The owner group holding the most listeners. */
export interface BusiestOwnerFact {
  readonly label: string;
  readonly count: number;
}

export interface ListenerFold {
  /** Listeners attached right now, after the view's filters. */
  readonly listeners: number;
  /** Listeners that delivered nothing in the window. */
  readonly idle: number;
  readonly duplicates: readonly DuplicateFact[];
  /** Listener-churn incidents raised over these listeners. */
  readonly churn: number;
  readonly busiest?: BusiestOwnerFact;
}

export interface ListenerStory {
  readonly headline: string;
  readonly finding: string;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function attachedCount(count: number): string {
  return count === 2 ? 'twice' : `${count} times`;
}

function headlineFor(fold: ListenerFold): string {
  if (fold.listeners === 0) return 'No listeners attached';
  const attached = plural(fold.listeners, 'listener');
  if (fold.duplicates.length > 0) {
    return `${attached}, ${fold.duplicates.length} attached more than once`;
  }
  if (fold.churn > 0) return `${attached}, ${fold.churn} reattaching repeatedly`;
  return `${attached} attached`;
}

function findingFor(fold: ListenerFold): string {
  if (fold.listeners === 0) {
    return 'Listeners the app attaches appear here as it opens them.';
  }
  const parts: string[] = [];
  const busiest = fold.busiest;
  if (busiest !== undefined && busiest.count > 1) {
    parts.push(`${busiest.label} holds ${busiest.count}.`);
  }
  const duplicate = fold.duplicates[0];
  if (duplicate !== undefined) {
    parts.push(`${duplicate.target} is attached ${attachedCount(duplicate.count)}.`);
  } else if (fold.churn > 0) {
    parts.push(`${plural(fold.churn, 'listener')} reattached repeatedly.`);
  } else {
    parts.push('No incidents.');
    if (fold.idle > 0) {
      parts.push(
        `${plural(fold.idle, 'listener')} ${
          fold.idle === 1 ? 'has' : 'have'
        } not delivered in this window.`,
      );
    }
  }
  return parts.join(' ');
}

/** The journal header's headline and finding for one fold. */
export function listenerStory(fold: ListenerFold): ListenerStory {
  return { headline: headlineFor(fold), finding: findingFor(fold) };
}
