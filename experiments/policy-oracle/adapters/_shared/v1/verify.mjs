// Shared receipt and evidence verifiers for RTDB, Storage, and native-model probes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCaseIds, canonicalJson, sha256 } from './fixture.mjs';

const UUID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64_ETAG_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function assertUuid(value, label = 'runId') {
  assert.ok(typeof value === 'string' && UUID_RE.test(value), label + ' must be a UUID');
}

export function assertSha256(value, label = 'sha256') {
  assert.ok(typeof value === 'string' && SHA256_RE.test(value), label + ' must be a 64-hex SHA-256');
}

export function assertDecision(value, label = 'decision') {
  assert.ok(value === 'ALLOW' || value === 'DENY', label + ' must be ALLOW or DENY');
  return value;
}

export function createMonotonicClock() {
  let last = 0;
  return {
    advance(timestamp, label = 'timestamp') {
      const ms = Date.parse(timestamp);
      assert.ok(Number.isFinite(ms) && ms >= last, 'out-of-order ' + label + ': ' + timestamp);
      last = ms;
      return ms;
    },
    current() {
      return last;
    },
  };
}

export function assertAnonymousIdentity(identity, expectedProject) {
  assert.ok(identity && typeof identity === 'object', 'missing identity');
  assert.match(identity.uid, UID_RE);
  assert.equal(identity.audience, expectedProject);
  assert.equal(identity.issuer, 'https://securetoken.google.com/' + expectedProject);
  assert.equal(identity.provider, 'anonymous');
}

// Generic RTDB authenticated-write-readback verifier parameterized by profile/fixture specs.
export function verifyRtdbReceipt(receipt, spec) {
  assertUuid(receipt.runId);
  assert.equal(receipt.project, spec.project);
  if (spec.sdk) assert.equal(receipt.sdk, spec.sdk);
  const instanceId = spec.instanceId(receipt.runId);
  const projectPath = 'projects/' + spec.projectNumber;
  const target = {
    name: projectPath + '/locations/' + (spec.location ?? 'us-central1') + '/instances/' + instanceId,
    project: projectPath,
    databaseUrl: 'https://' + instanceId + '.firebaseio.com',
    type: 'USER_DATABASE',
  };
  assert.deepEqual(receipt.created, { ...target, state: 'ACTIVE' });
  assert.deepEqual(receipt.cleanup.instance, { ...target, state: 'DELETED' });
  assert.equal(receipt.cleanup.identityDeleted, true);
  assert.deepEqual(receipt.cleanup.closed, { status: 401, body: { error: 'Permission denied' }, etag: null });

  const actor = receipt.identities[spec.actorKey ?? 'host'];
  assertAnonymousIdentity(actor, spec.project);

  for (const [profile, rulesBytes] of Object.entries(spec.profileRules)) {
    assert.deepEqual(receipt.releases[profile], {
      sourceSha256: sha256(rulesBytes),
      activeRulesMatchedBeforeAndAfter: true,
    });
  }

  const results = {};
  for (const [caseId, rowSpec] of Object.entries(spec.rows)) {
    const row = receipt.rows[caseId];
    assert.ok(row && typeof row === 'object', 'missing receipt row: ' + caseId);
    assert.equal(row.path, rowSpec.path(actor.uid));
    assert.equal(row.method, rowSpec.method);
    assert.deepEqual(row.submitted, rowSpec.submitted);
    for (const snap of [row.before, row.after]) {
      assert.equal(snap.status, 200);
      assert.match(snap.etag, BASE64_ETAG_RE);
    }
    assert.deepEqual(row.before.body, rowSpec.before);
    if (row.reply.status === 200) {
      if (rowSpec.expectedAfter !== undefined) {
        assert.deepEqual(row.after.body, rowSpec.expectedAfter);
      }
      assert.notEqual(row.after.etag, row.before.etag);
      results[caseId] = 'ALLOW';
    } else {
      assert.deepEqual(row.reply, { status: 401, body: { error: 'Permission denied' }, etag: null });
      assert.deepEqual(row.after, row.before);
      results[caseId] = 'DENY';
    }
    assert.equal(assertDecision(row.decision, caseId), results[caseId]);
  }
  assert.deepEqual(Object.keys(results).sort(), Object.keys(receipt.rows).sort());
  return results;
}

function assertStorageSnapshot(obj, bucket, expectedPath) {
  if (obj === null) return;
  assert.ok(obj && typeof obj === 'object', 'storage snapshot must be object or null');
  assert.equal(obj.name, expectedPath);
  assert.equal(obj.bucket, bucket);
  assert.match(obj.generation, /^[1-9][0-9]*$/);
  assert.match(obj.metageneration, /^[1-9][0-9]*$/);
  assert.match(obj.size, /^\d+$/);
  assertSha256(obj.sha256, expectedPath + ' sha256');
  assert.equal(typeof obj.contentType, 'string');
  assert.ok(Number.isFinite(Date.parse(obj.updated)));
}

// Generic Storage authenticated-write-readback verifier for upload/read/delete rows.
export function verifyStorageReceipt(receipt, spec) {
  assertUuid(receipt.runId);
  assert.equal(receipt.project, spec.project);
  assert.equal(receipt.endpoint, 'firebasestorage.googleapis.com');
  assert.equal(receipt.bucket, spec.bucketFor(receipt.runId));
  assert.equal(receipt.rulesSha256, sha256(spec.rulesBytes));
  assertAnonymousIdentity(receipt.identity, spec.project);

  const clock = createMonotonicClock();
  const latest = new Map(Object.entries(spec.initialSnapshots ?? {}));
  const decisions = {};
  for (const c of spec.cases) {
    const row = receipt.rows[c.id];
    assert.ok(row && typeof row === 'object', 'missing storage row: ' + c.id);
    assert.equal(row.path, c.path);
    assert.equal(row.op, c.op);
    assert.equal(row.actorUid, c.actor === 'signed' ? receipt.identity.uid : null);
    clock.advance(row.at, c.id + '.at');
    clock.advance(row.finishedAt, c.id + '.finishedAt');
    assertStorageSnapshot(row.before, receipt.bucket, c.path);
    assertStorageSnapshot(row.after, receipt.bucket, c.path);
    assert.deepEqual(row.before, latest.get(c.path) ?? null);
    const decision = assertDecision(row.decision, c.id);
    if (decision === 'DENY') {
      assert.ok(['storage/unauthorized', 'storage/unauthenticated'].includes(row.code));
      assert.deepEqual(row.after, row.before, c.id + ' refused object mutated');
    } else {
      assert.equal(row.code, 'ok');
      if (c.op === 'upload') {
        assert.notEqual(row.after.generation, row.before?.generation, c.id + ' generation unchanged');
        assert.equal(Number(row.after.size), c.size);
        if (c.mime !== undefined) assert.equal(row.after.contentType, c.mime);
      } else if (c.op === 'delete') {
        assert.equal(row.after, null);
      } else {
        assert.deepEqual(row.after, row.before);
      }
    }
    latest.set(c.path, row.after);
    decisions[c.id] = decision;
  }
  assert.deepEqual(Object.keys(receipt.rows).sort(), Object.keys(decisions).sort());
  return decisions;
}

export function verifyNativeTraceReceipt(trace, caseIds) {
  assertCaseIds(caseIds);
  assert.ok(trace && typeof trace === 'object', 'native trace must be an object');
  const results = trace.cases ?? trace;
  assert.deepEqual(Object.keys(results).sort(), [...caseIds].sort(), 'native trace case mismatch');
  for (const id of caseIds) {
    canonicalJson(results[id]);
  }
  return results;
}

export function runVerifierCli(verifyFn) {
  const [probeDir, rawPath] = process.argv.slice(2);
  assert.ok(probeDir && rawPath, 'usage: verify.mjs <probeDir> <rawReceiptPath>');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const decisions = verifyFn({ probeDir, rawPath, receipt: raw });
  console.log(JSON.stringify(decisions));
}
