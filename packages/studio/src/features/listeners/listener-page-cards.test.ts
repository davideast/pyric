import { describe, expect, it } from 'bun:test';
import {
  cardValueFormatter,
  listenerPageCards,
  listenerPageSeries,
  readsFootnote,
} from './listener-page-cards.js';

const totals = {
  deliveries: 3,
  snapshot: 41,
  reads: 43,
  service: 'firestore' as const,
  single: false,
};

describe('listenerPageCards', () => {
  it('states deliveries, the snapshot with its unit, and the read estimate', () => {
    expect(listenerPageCards(totals)).toEqual([
      { key: 'deliveries', label: 'Deliveries', total: 3 },
      { key: 'snapshot', label: 'Snapshot', total: 41, unit: 'documents' },
      { key: 'reads', label: 'Estimated reads', total: 43 },
    ]);
  });

  it('names one document for a listener on one document', () => {
    expect(listenerPageCards({ ...totals, snapshot: 0, single: true })[1]!.unit)
      .toBe('document');
  });

  it('names one document for a result set holding one', () => {
    expect(listenerPageCards({ ...totals, snapshot: 1 })[1]!.unit).toBe('document');
    expect(listenerPageCards({ ...totals, snapshot: 0 })[1]!.unit).toBe('documents');
  });

  it('leaves out the read estimate for the Realtime Database', () => {
    expect(listenerPageCards({ ...totals, service: 'database' }).map((card) => card.key))
      .toEqual(['deliveries', 'snapshot']);
  });
});

describe('cardValueFormatter', () => {
  it('puts the unit on the card that carries one, whatever the numbers are', () => {
    const cards = listenerPageCards({ ...totals, deliveries: 41 });
    const format = cardValueFormatter(cards, String);
    expect(cards.map((card) => format(card.total))).toEqual(['41', '41 documents', '43']);
  });
});

describe('listenerPageSeries', () => {
  it('carries each card as a total with no per-bucket values', () => {
    expect(listenerPageSeries(listenerPageCards(totals))).toEqual([
      { key: 'deliveries', label: 'Deliveries', values: [], total: 3 },
      { key: 'snapshot', label: 'Snapshot', values: [], total: 41 },
      { key: 'reads', label: 'Estimated reads', values: [], total: 43 },
    ]);
  });
});

describe('readsFootnote', () => {
  it('states the formula for Firestore and nothing for the Realtime Database', () => {
    expect(readsFootnote('firestore')).toBe(
      'Estimated reads: initial snapshot + documents added or modified since'
      + ' · reconnects and duplicate listeners not counted',
    );
    expect(readsFootnote('database')).toBeUndefined();
  });
});
