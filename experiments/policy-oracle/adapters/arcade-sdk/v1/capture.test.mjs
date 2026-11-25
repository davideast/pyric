import assert from 'node:assert/strict';
import { beforeAll, test } from 'bun:test';
import { captureAttempt } from './capture.mjs';
import { databasePath, normalizeEvidence, readProbe, releaseName, stockSha256, target, wireFields } from './evidence.mjs';

const probes = [
  new URL('../../../suites/arcade/yacht/claims/yacht-score/v1/probes/five-equal-dice/v1/', import.meta.url),
  new URL('../../../suites/arcade/sokoban/claims/push-tiebreak/v1/probes/equal-moves/v1/', import.meta.url),
];
const allowedCases = new Set(['score-50', 'pushes-9']);
const seedVersion = '2026-11-24T16:34:57.712345Z';
const commitVersion = '2026-11-24T16:35:00.123456Z';
const transformTime = '2026-11-24T16:35:00.123Z';
const transform = Symbol('server timestamp');
let evidence;

class MockTimestamp {
  static fromDate(date) {
    return new MockTimestamp(date);
  }
  constructor(date) {
    this.date = date;
  }
  toJSON() {
    const ms = +this.date;
    return { type: 'firestore/timestamp/1.0', seconds: Math.floor(ms / 1000), nanoseconds: ms % 1000 * 1e6 };
  }
}

function snapshot(document) {
  function decode(value) {
    if ('booleanValue' in value) return value.booleanValue;
    if ('stringValue' in value) return value.stringValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('arrayValue' in value) return value.arrayValue.values.map(decode);
    if ('timestampValue' in value) return MockTimestamp.fromDate(new Date(value.timestampValue));
    return Object.fromEntries(Object.entries(value.mapValue.fields).map(([name, field]) => [name, decode(field)]));
  }
  return {
    exists: () => Boolean(document),
    metadata: { fromCache: false, hasPendingWrites: false },
    data: () => decode({ mapValue: { fields: document.fields } }),
  };
}

function mockContext(caseId, allow) {
  const runId = 'synthetic-capture';
  const journals = [];
  const auth = uid => ({ currentUser: { uid }, app: { options: { projectId: target.project } } });
  const writerAuth = auth(caseId + '-writer');
  const readerAuth = auth('reader');
  const documents = new Map();
  async function commit(path, fields) {
    if (!allow) throw Object.assign(new Error('mock refusal'), { code: 'permission-denied' });
    documents.set(path, { ...documents.get(path), fields, updateTime: commitVersion });
  }

  return {
    journals,
    runId,
    writerAuth,
    readerAuth,
    sdkVersion: target.sdk,
    getIdTokenResult: async ({ uid }) => ({
      claims: { sub: uid, aud: target.project, iss: 'https://securetoken.google.com/' + target.project },
      signInProvider: 'anonymous',
    }),
    sdk: {
      Timestamp: MockTimestamp,
      initializeFirestore: (app, settings, database) => {
        assert.equal(database, target.database);
        assert.deepEqual(settings, { host: 'firestore.googleapis.com', ssl: true });
        return app;
      },
      doc: (app, path) => ({ firestore: app, path }),
      getDocFromServer: async ref => {
        assert.equal(ref.firestore, readerAuth.app);
        return snapshot(documents.get(ref.path));
      },
      runTransaction: async (app, transaction) => {
        assert.equal(app, writerAuth.app);
        let write;
        await transaction({
          get: async ref => snapshot(documents.get(ref.path)),
          update(ref, data) {
            write = { path: ref.path, fields: { ...documents.get(ref.path).fields, ...wireFields(data) } };
          },
        });
        assert.ok(write);
        await commit(write.path, write.fields);
      },
      serverTimestamp: () => transform,
      setDoc: async (ref, { createdAt, ...fields }) => {
        assert.equal(ref.firestore, writerAuth.app);
        assert.equal(createdAt, transform);
        await commit(ref.path, { ...wireFields(fields), createdAt: { timestampValue: transformTime } });
      },
    },
    createDocument: async (path, fields) => {
      assert.ok(!documents.has(path));
      const document = { name: databasePath + '/documents/' + path, fields, createTime: seedVersion, updateTime: seedVersion };
      documents.set(path, document);
      return document;
    },
    readDocument: async path => documents.get(path),
    verifyStock: async () => ({
      databaseUid: target.uid, releaseName, rulesetName: `projects/${target.project}/rulesets/test`,
      rulesSha256: stockSha256, lockRunId: runId, propagationReceiptSha256: 'a'.repeat(64), verifiedAt: new Date().toISOString(),
    }),
    journal: async row => journals.push(row),
  };
}

beforeAll(async () => {
  evidence = await Promise.all(probes.map(async probeUrl => {
    const probe = readProbe(probeUrl);
    const pairs = await Promise.all(probe.cases.map(async caseId => {
      const context = mockContext(caseId, allowedCases.has(caseId));
      const row = await captureAttempt(probeUrl, caseId, context);
      assert.equal(context.journals[0].writeSubmitted, false);
      assert.ok(!context.journals[0].decision);
      assert.deepEqual(context.journals.at(-1), row);
      return [caseId, row];
    }));
    return { probe, receipt: { rows: Object.fromEntries(pairs) } };
  }));
});

test('complete records from mocked SDK wiring normalize both decisions', () => {
  assert.deepEqual(normalizeEvidence(evidence[0].probe, evidence[0].receipt), { 'score-50': 'ALLOW', 'score-49': 'DENY' });
  assert.deepEqual(normalizeEvidence(evidence[1].probe, evidence[1].receipt), { 'pushes-9': 'ALLOW', 'pushes-10': 'DENY' });
});

test('a verdict-only receipt, missing attempt, or missing SDK read cannot qualify', () => {
  const { probe, receipt } = evidence[0];
  assert.throws(() => normalizeEvidence(probe, { rows: { 'score-50': 'ALLOW', 'score-49': 'DENY' } }));
  const altered = structuredClone(receipt);
  delete altered.rows['score-49'];
  assert.throws(() => normalizeEvidence(probe, altered));
  altered.rows['score-49'] = structuredClone(receipt.rows['score-49']);
  delete altered.rows['score-49'].transactionRead;
  assert.throws(() => normalizeEvidence(probe, altered));
});

test('readbacks must include full unchanged refusal data and a server version', () => {
  const { probe, receipt } = evidence[0];
  const missingField = structuredClone(receipt);
  const denial = missingField.rows['score-49'];
  delete denial.stored.data.nonces;
  delete denial.afterDocument.fields.nonces;
  assert.throws(() => normalizeEvidence(probe, missingField));

  const changedVersion = structuredClone(receipt);
  const changed = changedVersion.rows['score-49'];
  changed.afterVersion = changed.afterDocument.updateTime = commitVersion;
  assert.throws(() => normalizeEvidence(probe, changedVersion));
});

test('an allow requires the exact committed proposal and a newer version', () => {
  const { probe, receipt } = evidence[1];
  const unchanged = structuredClone(receipt);
  const allow = unchanged.rows['pushes-9'];
  allow.stored = allow.before;
  allow.afterDocument = allow.beforeDocument;
  allow.afterVersion = allow.beforeVersion;
  assert.throws(() => normalizeEvidence(probe, unchanged));
});

test('deployment propagation, authenticated identity and SDK write submission must match the capture', () => {
  const { probe, receipt } = evidence[0];
  for (const alter of [
    row => { row.deploymentAfter.rulesetName += '-drift'; },
    row => { delete row.deploymentAfter.propagationReceiptSha256; },
    row => { row.actor.audience = 'wrong-project'; },
    row => { row.writeSubmitted = false; },
  ]) {
    const altered = structuredClone(receipt);
    alter(altered.rows['score-49']);
    assert.throws(() => normalizeEvidence(probe, altered));
  }
});
