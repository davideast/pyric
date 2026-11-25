import test from 'node:test';
import assert from 'node:assert/strict';
import { dbName } from '../control.mjs';
import { floorCase, floorRecipe, runCase } from './candidate-case.mjs';
import { sdk } from './clients.mjs';

const actor = uid => ({ app: { uid }, identity: { uid }, auth: { currentUser: { uid } } });
const writer = actor('writer'), reader = actor('reader');
const recipe = floorRecipe({
  collection: 'steps',
  before: { writer: '$actor', reader: '$reader', before: { remaining: 0 },
    step: { h: 1/240, restart: false, landing: { id: 2, kind: 'boost', x: 160, y: 133, width: 58, broken: false } }, remaining: 0 },
  cases: [{ id: 'boost-44ms', update: { remaining: 0.044 } }, { id: 'boost-60ms', update: { remaining: 0.060 } }],
  positiveControl: 'boost-44ms',
});

function mock(outcome, tamper, { postReadErrors = [], events = [], counts = { writes: 0, verifies: 0 }, proof = () => ({}) } = {}) {
  let doc, fields;
  const runId = 'offline-test';
  const sample = floorCase(recipe, recipe.cases[0].id, writer, reader, runId);
  let submitted = false;
  const input = { sample, writer, reader, runId, tag: 'floor',
    journal: { event: (kind, data) => events.push({ kind, data: structuredClone(data) }) },
    verify: async () => proof(++counts.verifies),
  };
  const io = {
    wait: async () => {},
    sdk: {
      ...sdk,
      initializeFirestore: app => app, doc: (app, path) => ({ app, path }),
      async getDocFromServer(ref) {
        assert.equal(ref.app, reader.app);
        if (submitted && postReadErrors.length) throw Object.assign(Error('server read failed'), { code: postReadErrors.shift() });
        return { exists: () => true, metadata: { fromCache: false, hasPendingWrites: false }, data: () => fields };
      },
      async updateDoc(ref, update) {
        assert.equal(ref.app, writer.app);
        assert.ok(events.some(e => e.kind === 'candidate-input'));
        submitted = true;
        counts.writes++;
        if (outcome === 'DENY') {
          if (tamper) doc.updateTime = '2026-11-25T12:34:57.100001Z';
          throw Object.assign(Error('refused'), { code: 'permission-denied' });
        }
        fields = { ...fields, ...update };
        doc.fields.remaining = { doubleValue: tamper ? 0.06 : update.remaining };
        doc.updateTime = '2026-11-25T12:34:57.100001Z';
      },
    },
    async createDocument(path, wire) {
      assert.deepEqual(wire.step.mapValue.fields.h, { doubleValue: 1/240 });
      assert.deepEqual(wire.step.mapValue.fields.landing.mapValue.fields.id, { integerValue: '2' });
      fields = structuredClone(sample.before);
      doc = { name: dbName + '/documents/' + path, fields: wire, createTime: '2026-11-25T12:34:56Z', updateTime: '2026-11-25T12:34:56Z' };
      return structuredClone(doc);
    },
    async readDocument() { return structuredClone(doc); },
  };
  return runCase(input, io);
}

test('Floor authenticates the write role and preserves fractional timer inputs across readbacks', async () => {
  const row = await mock('ALLOW');
  assert.equal(row.stored.data.remaining, 0.044);
  assert.equal(row.afterDocument.fields.remaining.doubleValue, 0.044);
});

test('refusal requires the same stored fields and server version', async () => {
  const row = await mock('DENY');
  assert.deepEqual(row.beforeDocument, row.afterDocument);
  await assert.rejects(mock('DENY', true));
});

test('a privileged document that disagrees with an SDK readback fails the capture', async () => {
  await assert.rejects(mock('ALLOW', true));
});

test('a temporary signed post-read refusal checks the release again and never repeats the write', async () => {
  const events = [], counts = { writes: 0, verifies: 0 };
  const row = await mock('ALLOW', false, { postReadErrors: ['permission-denied'], events, counts });
  assert.equal(row.stored.data.remaining, 0.044);
  assert.equal(counts.writes, 1);
  assert.ok(counts.verifies >= 3);
  const attempts = events.filter(e => e.kind === 'candidate-signed-post-read');
  assert.deepEqual(attempts.map(e => e.data.code), ['permission-denied', 'ok']);
  assert.ok(events.some(e => e.kind === 'candidate-rest-after-write' && e.data.document.fields.remaining.doubleValue === 0.044));
});

test('a consistently unreadable scored document stays incomplete with its raw REST witness retained', async () => {
  const events = [], counts = { writes: 0, verifies: 0 };
  await assert.rejects(mock('ALLOW', false, { postReadErrors: Array(100).fill('permission-denied'), events, counts }));
  const attempts = events.filter(e => e.kind === 'candidate-signed-post-read');
  assert.equal(attempts.length, 6);
  assert.ok(attempts.every(e => e.data.code === 'permission-denied'));
  assert.equal(counts.writes, 1);
  assert.ok(events.some(e => e.kind === 'candidate-rest-after-write'));
});

test('an authentication failure is journaled once and does not trigger read retries', async () => {
  const events = [];
  await assert.rejects(mock('ALLOW', false, { postReadErrors: ['unauthenticated'], events }));
  assert.deepEqual(events.filter(e => e.kind === 'candidate-signed-post-read').map(e => e.data.code), ['unauthenticated']);
});

test('a changed release stops the retry before another signed read', async () => {
  const events = [], counts = { writes: 0, verifies: 0 };
  const proof = count => ({ releaseUpdateTime: count < 3 ? 'original' : 'changed' });
  await assert.rejects(mock('ALLOW', false, { postReadErrors: ['permission-denied'], events, counts, proof }), /release or lease changed/);
  assert.equal(counts.writes, 1);
  assert.equal(events.filter(e => e.kind === 'candidate-signed-post-read').length, 1);
});
