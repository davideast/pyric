import { describe, it, expect } from 'bun:test';
import { Timestamp, GeoPoint, Bytes } from 'pyric/firestore';
import { treeFromData, treeToData } from '../../../src/firestore/reducers/tree.js';

describe('treeFromData + treeToData', () => {
  it('round-trips a primitive-only document', () => {
    const data = { name: 'Alice', score: 42, active: true, missing: null };
    const tree = treeFromData(data);
    expect(treeToData(tree)).toEqual(data);
  });

  it('round-trips nested maps', () => {
    const data = { addr: { city: 'SF', zip: '94110' }, level: 1 };
    expect(treeToData(treeFromData(data))).toEqual(data);
  });

  it('round-trips arrays of primitives', () => {
    const data = { tags: ['admin', 'beta'] };
    expect(treeToData(treeFromData(data))).toEqual(data);
  });

  it('round-trips arrays of maps', () => {
    const data = {
      users: [
        { name: 'Alice', score: 1 },
        { name: 'Bob', score: 2 },
      ],
    };
    expect(treeToData(treeFromData(data))).toEqual(data);
  });

  it('preserves Timestamp, GeoPoint, Bytes by reference', () => {
    const ts = Timestamp.fromDate(new Date('2025-04-01T00:00:00Z'));
    const gp = new GeoPoint(37.7749, -122.4194);
    const by = Bytes.fromBase64String('aGVsbG8=');
    const data = { ts, gp, by };
    const out = treeToData(treeFromData(data));
    expect(out.ts).toBe(ts);
    expect(out.gp).toBe(gp);
    expect(out.by).toBe(by);
  });

  it('round-trips an empty document', () => {
    expect(treeToData(treeFromData({}))).toEqual({});
  });

  it('assigns unique node ids to every entry', () => {
    const tree = treeFromData({ a: 1, b: { c: 2 } });
    const ids = Object.keys(tree.nodes);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
