import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { manifest, versionNs } from '../../corpus.mjs';
import { dbName } from '../control.mjs';
import { createDocument, readDocument, sdk, SDK_VERSION } from './clients.mjs';
import { errorDetails, now } from './archive.mjs';

export function floorRecipe(value) {
  assert.equal(value.collection, 'steps');
  assert.deepEqual(value.before, {
    writer: '$actor', reader: '$reader', before: { remaining: 0 },
    step: { h: 1/240, restart: false, landing: { id: 2, kind: 'boost', x: 160, y: 133, width: 58, broken: false } },
    remaining: 0,
  });
  assert.deepEqual(value.cases.map(c => c.update).sort((a,b) => a.remaining-b.remaining),
    [{ remaining: 0.044 }, { remaining: 0.060 }]);
  const ids = value.cases.map(c => c.id);
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.includes(value.positiveControl));
  return value;
}

export function floorCase(recipe, id, writer, reader, runId) {
  const before = { ...recipe.before, writer: writer.identity.uid, reader: reader.identity.uid };
  return { caseId: id, path: 'steps/oracle-' + runId + '-' + randomUUID(), operation: 'update', before,
    data: recipe.cases.find(c => c.id === id).update };
}

function wireValue(value) {
  if (value instanceof sdk.Timestamp) return { timestampValue: value.toDate().toISOString() }; // millisecond fixture seed
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isSafeInteger(value)) return { integerValue: String(value) };
  if (Number.isFinite(value)) return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(wireValue) } };
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return { mapValue: { fields: wireFields(value) } };
}
const wireFields = obj => Object.fromEntries(Object.entries(obj).map(([k,v]) => [k,wireValue(v)]));

function decode(value) {
  if ('timestampValue' in value) {
    const nanos = versionNs(value.timestampValue);
    return new sdk.Timestamp(Number(nanos / 1000000000n), Number(nanos % 1000000000n)).toJSON();
  }
  if ('integerValue' in value) {
    const n = Number(value.integerValue);
    assert.ok(Number.isSafeInteger(n));
    return n;
  }
  if ('doubleValue' in value) { assert.ok(Number.isFinite(value.doubleValue)); return value.doubleValue; }
  if ('booleanValue' in value) return value.booleanValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decode);
  assert.ok('mapValue' in value);
  return Object.fromEntries(Object.entries(value.mapValue.fields).map(([k,v]) => [k,decode(v)]));
}

async function verdict(send) {
  try { return { decision: 'ALLOW', code: 'ok', result: await send() }; }
  catch (error) {
    if (error.code !== 'permission-denied') throw error;
    return { decision: 'DENY', code: error.code };
  }
}

const transport = { sdk, createDocument, readDocument, wait: delay };
const readbackAttempts = 6;
const readbackIntervalMs = 5000;

async function signedPostRead({ snapshot, verify, deploymentBefore, reader, journal, context, wait }) {
  const attempts = [];
  for (let number = 1; number <= readbackAttempts; number++) {
    if (number > 1) await wait(readbackIntervalMs);
    const proof = await verify();
    for (const key of ['databaseUid', 'releaseName', 'rulesetName', 'rulesSha256', 'lockRunId', 'lockVersion', 'releaseUpdateTime', 'propagationReceiptSha256']) {
      assert.equal(proof[key], deploymentBefore[key], 'release or lease changed during readback: ' + key);
    }
    assert.equal(reader.auth.currentUser.uid, reader.identity.uid);
    const attemptedAt = now();
    let observation, failure;
    try { observation = await snapshot(); }
    catch (error) { failure = error; observation = { decision: 'ERROR', ...errorDetails(error) }; }
    const attempt = { number, attemptedAt, readAt: now(), proof, ...observation };
    journal.event('candidate-signed-post-read', { ...context, ...attempt });
    attempts.push(attempt);
    if (observation.decision === 'ALLOW') return { stored: observation, attempts };
    const retryable = ['permission-denied', 'unavailable', 'deadline-exceeded'].includes(observation.code);
    if (!retryable || number === readbackAttempts) {
      throw failure ?? Object.assign(new Error('scored document could not be read from the server'), { code: observation.code });
    }
  }
}
export async function runCase({ sample, writer, reader, journal, runId, tag, control = false, submitter = writer, verify }, io = transport) {
  const { sdk, createDocument, readDocument } = io;
  const { caseId, path, operation, data } = sample;
  const seed = { ...sample.before };
  if (operation === 'set' || operation === 'transaction-update') seed.createdAt = sdk.Timestamp.fromDate(new Date(seed.createdAt));
  const expectedBefore = JSON.parse(JSON.stringify(seed));
  assert.equal(writer.auth.currentUser.uid, writer.identity.uid);
  assert.equal(reader.auth.currentUser.uid, reader.identity.uid);
  assert.equal(submitter.auth.currentUser.uid, submitter.identity.uid);
  const deploymentBefore = await verify();
  const ref = client => sdk.doc(sdk.initializeFirestore(client.app, { host: 'firestore.googleapis.com', ssl: true }, manifest.target.database), path);
  const readRef = ref(reader);
  const submitRef = ref(submitter);
  async function snapshot() {
    const { decision, code, result } = await verdict(() => sdk.getDocFromServer(readRef));
    if (decision === 'DENY') return { decision, code };
    assert.ok(result.exists());
    assert.equal(result.metadata.fromCache, false);
    assert.equal(result.metadata.hasPendingWrites, false);
    return { decision, code, fromCache: false, hasPendingWrites: false, data: JSON.parse(JSON.stringify(result.data())) };
  }
  const seedDocument = await createDocument(path, wireFields(seed));
  assert.equal(seedDocument.name, dbName + '/documents/' + path);
  assert.deepEqual(decode({ mapValue: { fields: seedDocument.fields } }), expectedBefore);
  const before = await snapshot();
  if (!control) assert.equal(before.decision, 'ALLOW');
  if (before.decision === 'ALLOW') assert.deepEqual(before.data, expectedBefore);
  const beforeDocument = await readDocument(path);
  assert.deepEqual(beforeDocument, seedDocument);
  const row = { tag, runId, caseId, operation, path, sdkVersion: SDK_VERSION, endpoint: 'firestore.googleapis.com',
    project: manifest.target.project, database: manifest.target.database, actor: submitter.identity, reader: reader.identity,
    seedDocument, beforeDocument, before, proposal: data, attemptedAt: now(), deploymentBefore };
  journal.event('candidate-input', row);
  let send;
  if (operation === 'set') {
    assert.equal(data.createdAt, '$serverTimestamp');
    send = () => sdk.setDoc(submitRef, { ...data, createdAt: sdk.serverTimestamp() });
  } else if (operation === 'transaction-update') {
    send = () => sdk.runTransaction(submitRef.firestore, async transaction => {
      const snap = await transaction.get(submitRef);
      assert.ok(snap.exists());
      row.transactionRead = JSON.parse(JSON.stringify(snap.data()));
      assert.deepEqual(row.transactionRead, expectedBefore);
      transaction.update(submitRef, data);
      row.writeSubmitted = true;
    }, { maxAttempts: 1 });
  } else {
    assert.equal(operation, 'update');
    send = () => sdk.updateDoc(submitRef, data);
  }
  const { decision, code } = await verdict(send);
  if (operation === 'transaction-update') assert.equal(row.writeSubmitted, true, 'transaction did not submit a write');
  Object.assign(row, { decision, code });
  journal.event('candidate-verdict', { tag, runId, caseId, path, decision, code, at: now() });
  if (control) {
    row.stored = await snapshot();
  } else {
    const context = { tag, runId, caseId, path };
    const document = await readDocument(path);
    journal.event('candidate-rest-after-write', { ...context, document });
    const { stored, attempts } = await signedPostRead({ snapshot, verify, deploymentBefore, reader, journal, context, wait: io.wait });
    row.stored = stored;
    row.readAttempts = attempts;
    row.firstAfterDocument = document;
  }
  row.readAt = now();
  row.afterDocument = await readDocument(path);
  journal.event('candidate-readback-observed', { tag, runId, caseId, path, stored: row.stored, document: row.afterDocument });
  if (!control) assert.deepEqual(row.afterDocument, row.firstAfterDocument, 'document changed during signed readback');
  assert.equal(row.afterDocument.name, seedDocument.name);
  assert.equal(row.afterDocument.createTime, seedDocument.createTime);
  const stored = decode({ mapValue: { fields: row.afterDocument.fields } });
  if (!control) assert.equal(row.stored.decision, 'ALLOW');
  if (row.stored.decision === 'ALLOW') assert.deepEqual(row.stored.data, stored);
  const beforeVersion = versionNs(beforeDocument.updateTime);
  const afterVersion = versionNs(row.afterDocument.updateTime);
  if (decision === 'ALLOW') {
    assert.ok(afterVersion > beforeVersion);
    if (operation === 'set') {
      const createdNs = versionNs(row.afterDocument.fields.createdAt.timestampValue);
      assert.ok(createdNs > versionNs(seedDocument.fields.createdAt.timestampValue));
      assert.deepEqual(stored, { ...data, createdAt: stored.createdAt });
    } else {
      assert.deepEqual(stored, { ...expectedBefore, ...data });
    }
  } else {
    assert.deepEqual(seedDocument, row.afterDocument);
    assert.equal(afterVersion, beforeVersion);
  }
  if (!control) row.deploymentAfter = await verify();
  journal.event('candidate-readback', row);
  return row;
}

export async function floorPropagation({ phase, proof, runId, recipe, writer, reader, journal, checkStop }) {
  const open = phase === 'open';
  const started = Date.now();
  const controls = [];
  let consecutive = 0;
  do {
    if (phase !== 'restored-closed') checkStop();
    const round = [];
    for (const submitter of open ? [writer, reader] : [writer]) {
      const sample = floorCase(recipe, recipe.positiveControl, writer, reader, runId);
      const row = await runCase({ sample, writer, reader, submitter, journal, runId, tag: phase, control: true,
        verify: async () => proof });
      controls.push(row);
      const readDecision = open ? 'ALLOW' : 'DENY';
      round.push(row.before.decision === readDecision && row.stored.decision === readDecision &&
        row.decision === (open && submitter === writer ? 'ALLOW' : 'DENY'));
    }
    consecutive = round.every(Boolean) ? consecutive + 1 : 0;
    if (consecutive === 2) {
      const digest = journal.retain({ phase, proof, controls });
      journal.event('propagation-confirmed', { phase, proof, digest });
      return digest;
    }
    await delay(2500);
  } while (Date.now() - started < 240000);
  throw Error('Floor data-plane propagation timed out');
}
