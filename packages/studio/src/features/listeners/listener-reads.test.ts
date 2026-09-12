import { describe, expect, it } from 'bun:test';
import { estimatedDocumentReads } from './listener-reads.js';
import type { ListenerDelivery } from './listener-delivery-docs.js';

function delivery(fields: Partial<ListenerDelivery> & { at: number }): ListenerDelivery {
  return {
    initial: false,
    addedCount: 0,
    modifiedCount: 0,
    removedCount: 0,
    size: 0,
    docs: [],
    ...fields,
  };
}

describe('estimatedDocumentReads', () => {
  it('counts the initial snapshot, then documents added or changed since', () => {
    expect(estimatedDocumentReads([
      delivery({ at: 1, initial: true, size: 40, addedCount: 40 }),
      delivery({ at: 2, addedCount: 40, modifiedCount: 3, size: 40 }),
      delivery({ at: 3, addedCount: 1, size: 41 }),
    ])).toBe(40 + 43 + 1);
  });

  it('charges one read for an initial snapshot that came back empty', () => {
    expect(estimatedDocumentReads([delivery({ at: 1, initial: true, size: 0 })])).toBe(1);
  });

  it('charges nothing for a delivery that only dropped documents', () => {
    expect(estimatedDocumentReads([
      delivery({ at: 1, initial: true, size: 5 }),
      delivery({ at: 2, removedCount: 2, size: 3 }),
    ])).toBe(5);
  });

  it('counts nothing for a listener that has never delivered', () => {
    expect(estimatedDocumentReads([])).toBe(0);
  });
});
