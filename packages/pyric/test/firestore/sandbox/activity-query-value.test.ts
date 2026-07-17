import { describe, expect, it } from 'bun:test';
import { activityValue } from '../../../src/firestore/sandbox/activity-query-value.js';
import { FirestoreImpl } from '../../../src/sandbox/firestore/admin-compat/firestore.js';
import { Timestamp as AdminTimestamp } from '../../../src/sandbox/firestore/admin-compat/types.js';
import { LocalEnvironment } from '../../../src/sandbox/internal/index.js';
import { Bytes, GeoPoint, Timestamp } from '../../../src/firestore/field-values.js';

describe('activity query operand identity', () => {
  it('never invokes user toJSON methods or getters', () => {
    let calls = 0;
    const operand = Object.defineProperties({ marker: 'before' }, {
      toJSON: {
        value() { calls += 1; return { marker: 'after' }; },
        enumerable: false,
      },
      computed: {
        get() { calls += 1; return 'value'; },
        enumerable: true,
      },
    });

    const first = activityValue(operand);
    const second = activityValue(operand);

    expect(calls).toBe(0);
    expect(first).toEqual(second);
  });

  it('never executes Proxy traps, including during an empty query', async () => {
    const fail = () => { throw new Error('diagnostics executed a Proxy trap'); };
    const operand = new Proxy({}, {
      get: fail,
      getOwnPropertyDescriptor: fail,
      getPrototypeOf: fail,
      has: fail,
      ownKeys: fail,
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    expect(() => activityValue(operand)).not.toThrow();
    expect(() => activityValue(revoked.proxy)).not.toThrow();

    const rules = `rules_version = '2'; service cloud.firestore {
      match /databases/{database}/documents { match /{document=**} { allow read: if true; } }
    }`;
    const env = new LocalEnvironment();
    env.deployRules(rules);
    const db = new FirestoreImpl(env, { uid: 'alice' });
    const result = await db.collection('empty').where('field', '==', operand).get();
    expect(result.empty).toBe(true);
  });

  it('never invokes getters while constructing filters or cursors', () => {
    let calls = 0;
    const operand = Object.defineProperty({}, 'computed', {
      get() { calls += 1; return 'value'; },
      enumerable: true,
    });
    const env = new LocalEnvironment();
    const query = new FirestoreImpl(env, { uid: 'alice' }).collection('empty');

    query.where('field', '==', operand);
    query.applyFilter({ kind: 'where', field: 'field', op: '==', value: operand });
    query.startCursor([operand], true);
    query.endCursor([operand], false);

    expect(calls).toBe(0);
  });

  it('keeps diagnostic tags distinct from arbitrary maps and arrays', () => {
    expect(activityValue(Number.NaN)).not.toEqual(activityValue({ type: 'number', value: 'NaN' }));
    expect(activityValue([1, 2])).not.toEqual(activityValue({ type: 'array', length: 2 }));
    expect(activityValue(new AdminTimestamp(1, 2))).not.toEqual(activityValue({
      type: 'firestore-value',
      value: { type: 'timestamp', seconds: 1, nanoseconds: 2 },
    }));
  });

  it('uses conservative identity for arrays without reading their contents', () => {
    const first = ['same'];
    const second = ['same'];

    expect(activityValue(first)).toEqual(activityValue(first));
    expect(activityValue(first)).not.toEqual(activityValue(second));
  });

  it('canonicalizes trusted Bytes and GeoPoint instances without reflection', () => {
    expect(activityValue(Bytes.fromUint8Array(new Uint8Array([1, 2])))).toEqual(
      activityValue(Bytes.fromUint8Array(new Uint8Array([1, 2]))),
    );
    expect(activityValue(new GeoPoint(10, 20))).toEqual(activityValue(new GeoPoint(10, 20)));
  });

  it('canonicalizes equivalent trusted timestamps and document references', () => {
    const env = new LocalEnvironment();
    const db = new FirestoreImpl(env, { uid: 'alice' });

    expect(activityValue(new Timestamp(1, 2))).toEqual(activityValue(new Timestamp(1, 2)));
    expect(activityValue(db.doc('owners/alice'))).toEqual(
      activityValue(db.doc('owners/alice')),
    );
  });

  it('keeps large primitive and Bytes descriptors bounded', () => {
    const longString = 'x'.repeat(1_048_576);
    const largeBytes = Bytes.fromUint8Array(new Uint8Array(1_048_576).fill(255));

    expect(JSON.stringify(activityValue(longString)).length).toBeLessThan(256);
    expect(JSON.stringify(activityValue(largeBytes)).length).toBeLessThan(256);
    expect(activityValue(longString)).toEqual(activityValue('x'.repeat(1_048_576)));
    expect(activityValue(largeBytes)).toEqual(
      activityValue(Bytes.fromUint8Array(new Uint8Array(1_048_576).fill(255))),
    );
  });

  it('never exposes scalar query operands in diagnostic descriptors', () => {
    const secret = '123-45-6789';
    const stringDescriptor = JSON.stringify(activityValue(secret));
    const numberDescriptor = JSON.stringify(activityValue(8675309));

    expect(stringDescriptor).not.toContain(secret);
    expect(numberDescriptor).not.toContain('8675309');
    expect(activityValue(secret)).toEqual(activityValue(secret));
    expect(activityValue(secret)).not.toEqual(activityValue('987-65-4321'));
  });

  it('does not let diagnostics mutate an operand before query evaluation', async () => {
    const rules = `rules_version = '2'; service cloud.firestore {
      match /databases/{database}/documents { match /{document=**} { allow read: if true; } }
    }`;
    const env = new LocalEnvironment();
    env.deployRules(rules);
    env.seed({ rules, documents: { 'items/a': { field: { marker: 'before' } } } });
    const db = new FirestoreImpl(env, { uid: 'alice' });
    const operand = Object.defineProperty({ marker: 'before' }, 'toJSON', {
      value() { this.marker = 'after'; return { marker: this.marker }; },
      enumerable: false,
    });

    const result = await db.collection('items').where('field', '==', operand).get();

    expect(operand.marker).toBe('before');
    expect(result.size).toBe(1);
  });
});
