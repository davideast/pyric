import assert from 'node:assert/strict';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { doc, getFirestore, Timestamp, Bytes, GeoPoint, vector } from 'pyric/firestore';
import { encodeHistory, decodeHistory, historyChecksum } from '../../../src/serve/hosted/persistence/history-codec.js';
const sandbox = createSandboxRoot();
const values = { numbers: [NaN, Infinity, -Infinity, -0], timestamp: new Timestamp(123, 456), date: new Date(123000), bytes: Bytes.fromUint8Array(new Uint8Array([0, 128, 255])),
  point: new GeoPoint(30, -80), vector: vector([1, 2, 3]), reference: doc(getFirestore(sandbox), 'values/reference'),
  literal: { type: 'pyric/map/1.0', fields: { nested: { __type: 'reference', path: 'literal/path' } } } };
try {
  const encoded = encodeHistory(values);
  const decoded = decodeHistory(encoded, historyChecksum(encoded));
  assert.deepEqual(decoded.literal, values.literal);
  assert.deepEqual(decoded.numbers, values.numbers);
  assert.equal(decoded.timestamp.seconds, 123);
  assert.equal(decoded.timestamp.nanos, 456);
  assert.equal(decoded.date.seconds, 123);
  const buffer = globalThis.Buffer;
  Reflect.deleteProperty(globalThis, 'Buffer');
  try { assert.deepEqual(decodeHistory(encoded, historyChecksum(encoded)), decoded); }
  finally { globalThis.Buffer = buffer; }
  assert.throws(() => decodeHistory(`${encoded} `, historyChecksum(encoded)), /checksum/);
} finally { sandbox.dispose(); }
console.log('History values passed');
