/**
 * The three totals over one listener (feature: Listeners).
 *
 * PURE. The page states how often the callback ran, how much it holds now, and
 * what holding it has cost. The Realtime Database bills by data transferred
 * rather than by document, so its page states no reads.
 *
 * The card strip takes one value formatter for the whole strip, and one of
 * these values carries a unit. The strip maps over the series once per render
 * and formats each in turn, so {@link cardValueFormatter} answers by position.
 */

import type { MetricSeries } from '@pyric/ui/traffic';

export interface ListenerPageCard {
  readonly key: string;
  readonly label: string;
  readonly total: number;
  /** The word after the number, for a value that needs one. */
  readonly unit?: string;
}

export interface ListenerTotals {
  readonly deliveries: number;
  /** Documents in the newest snapshot. */
  readonly snapshot: number;
  readonly reads: number;
  readonly service: 'firestore' | 'database';
  /** True when the listener watches one document rather than a query. */
  readonly single: boolean;
}

export function listenerPageCards(totals: ListenerTotals): readonly ListenerPageCard[] {
  const cards: ListenerPageCard[] = [
    { key: 'deliveries', label: 'Deliveries', total: totals.deliveries },
    {
      key: 'snapshot',
      label: 'Snapshot',
      total: totals.snapshot,
      unit: totals.single ? 'document' : 'documents',
    },
  ];
  if (totals.service === 'firestore') {
    cards.push({ key: 'reads', label: 'Estimated reads', total: totals.reads });
  }
  return cards;
}

/** The cards as the strip's series. */
export function listenerPageSeries(cards: readonly ListenerPageCard[]): MetricSeries[] {
  return cards.map((card) => ({
    key: card.key,
    label: card.label,
    values: [],
    total: card.total,
  }));
}

/**
 * A formatter for one render of the strip: it answers the cards in order, so
 * the card that carries a unit gets it whatever its number is. Build a fresh
 * one per render — it advances as the strip consumes it.
 */
export function cardValueFormatter(
  cards: readonly ListenerPageCard[],
  format: (value: number) => string,
): (value: number) => string {
  let index = 0;
  return (value) => {
    const card = cards[index];
    index += 1;
    return card?.unit === undefined ? format(value) : `${format(value)} ${card.unit}`;
  };
}

/** The line under the cards, stating what the read estimate covers. Nothing for
 *  the Realtime Database, which has no read to estimate. */
export function readsFootnote(service: 'firestore' | 'database'): string | undefined {
  if (service !== 'firestore') return undefined;
  return 'Estimated reads: initial snapshot + documents added or modified since'
    + ' · reconnects and duplicate listeners not counted';
}
