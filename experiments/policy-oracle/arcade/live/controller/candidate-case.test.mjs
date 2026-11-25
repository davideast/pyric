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

function mock(outcome, tamper) {
  let doc, fields;
  const runId = 'offline-test';
  const sample = floorCase(recipe, recipe.cases[0].id, writer, reader, runId);
  const events = [];
  const input = { sample, writer, reader, runId, tag: 'floor', journal: { event: kind => events.push(kind) }, verify: async () => ({}) };
  const io = {
    sdk: {
      ...sdk,
      initializeFirestore: app => app, doc: (app, path) => ({ app, path }),
      async getDocFromServer(ref) {
        assert.equal(ref.app, reader.app);
        return { exists: () => true, metadata: { fromCache: false, hasPendingWrites: false }, data: () => fields };
      },
      async updateDoc(ref, update) {
        assert.equal(ref.app, writer.app);
        assert.equal(events[0], 'candidate-input');
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
