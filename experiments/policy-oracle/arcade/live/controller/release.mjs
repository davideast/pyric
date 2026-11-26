import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import { api, dbName, dbUrl, currentRelease, preflight, releaseLock, releaseName, switchRelease, takeLock, uploadRules } from '../control.mjs';
import { manifest, sha } from '../../corpus.mjs';
import { now } from './archive.mjs';

const { uid, project, closedRuleset } = manifest.target;
const closedSha = manifest.files['v1/rules/closed.rules'];
const lockUrl = dbUrl + '/documents/oracleLocks/arcade-counter';
const preparedRelease = new AsyncLocalStorage();

// Reuse immutable Rules bytes only within this one capture invocation.
export function withPreparedRuleset(name, run) {
  const prefix = 'projects/' + project + '/rulesets/';
  assert.ok(typeof name === 'string' && name.startsWith(prefix));
  assert.match(name.slice(prefix.length), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  return preparedRelease.run(name, run);
}

async function verifyLease(runId, lockVersion) {
  const db = await api(dbUrl);
  assert.equal(db.name, dbName);
  assert.equal(db.uid, uid);
  const lock = await api(lockUrl);
  assert.equal(lock.name, dbName + '/documents/oracleLocks/arcade-counter');
  assert.equal(lock.fields.runId.stringValue, runId);
  assert.equal(lock.updateTime, lockVersion);
  return lock;
}

async function inspect(runId, lockVersion, expectedName, expectedSha) {
  await verifyLease(runId, lockVersion);
  const release = await currentRelease();
  assert.equal(release.rulesetName, expectedName);
  const rules = await api('https://firebaserules.googleapis.com/v1/' + expectedName);
  assert.equal(rules.name, expectedName);
  assert.equal(rules.source.files.length, 1);
  const digest = sha(rules.source.files[0].content);
  assert.equal(digest, expectedSha);
  return { databaseUid: uid, releaseName, rulesetName: expectedName, rulesSha256: digest,
    lockRunId: runId, lockVersion, releaseUpdateTime: release.updateTime, verifiedAt: now() };
}

const management = { inspect, verifyLease, preflight, takeLock, releaseLock, switchRelease, uploadRules, currentRelease,
  async getRuleset(name) { return api('https://firebaserules.googleapis.com/v1/' + name); },
  async recoverLock(runId) {
    const lock = await api(lockUrl);
    if (lock.fields.runId.stringValue === runId) return lock.updateTime;
  },
};

// The caller supplies independent, authenticated data-plane checks for this exact
// bundle. Management never releases a lease after an ambiguous restoration.
export async function withRelease({ runId, journal, source, digest, setupClients, checkPropagation, capture, checkStop }, service = management) {
  assert.equal(sha(source), digest);
  assert.match(runId, /^[a-f0-9-]{36}$/);
  const setup = await service.preflight();
  assert.equal(setup.release.rulesetName, closedRuleset);
  let version, candidate, patchAttempted = false, canUnlock = false, activeProof, result;
  const inspectRelease = (name, hash) => service.inspect(runId, version, name, hash);
  try {
    try {
      version = await service.takeLock(runId);
    } catch (error) {
      // A lost create response can leave a lease bearing our unique ID.
      version = await service.recoverLock(runId).catch(() => undefined);
      throw error;
    }
    const initial = await inspectRelease(closedRuleset, closedSha);
    journal.event('acquired', initial);
    await setupClients(setup.config);
    await checkPropagation('initially-closed', initial);
    checkStop();
    const prepared = preparedRelease.getStore();
    if (prepared) {
      const rule = await service.getRuleset(prepared);
      assert.equal(rule.name, prepared);
      assert.equal(rule.attachmentPoint, 'firestore.googleapis.com/projects/' + setup.projectNumber + '/databases/' + manifest.target.database);
      assert.deepEqual(rule.metadata.services, ['cloud.firestore']);
      assert.deepEqual(rule.source.files, [{name: 'firestore.rules', content: source}]);
      assert.equal(sha(rule.source.files[0].content), digest);
      candidate = prepared;
      journal.event('reuse-reviewed-ruleset', {candidate, digest});
    } else {
      candidate = await service.uploadRules(source, setup.projectNumber, digest);
    }
    assert.ok(candidate.startsWith('projects/' + project + '/rulesets/'));
    assert.notEqual(candidate, closedRuleset);
    await inspectRelease(closedRuleset, closedSha);
    journal.event('activate', { candidate, digest, previous: closedRuleset });
    patchAttempted = true;
    await service.switchRelease(candidate);
    activeProof = await inspectRelease(candidate, digest);
    const propagationReceiptSha256 = await checkPropagation('open', activeProof);
    assert.match(propagationReceiptSha256, /^[a-f0-9]{64}$/);
    const verify = async () => ({ ...await inspectRelease(candidate, digest), propagationReceiptSha256 });
    checkStop();
    result = await capture(verify);
  } finally {
    if (version) {
      try {
        await service.verifyLease(runId, version);
        const current = await service.currentRelease();
        if (patchAttempted) {
          // Only undo our own activation. After a lost PATCH response it is
          // possible that either our candidate or the original is still named.
          assert.ok([candidate, closedRuleset].includes(current.rulesetName), 'unexpected third-party release');
          await service.switchRelease(closedRuleset);
        }
        const closed = await inspectRelease(closedRuleset, closedSha);
        if (patchAttempted) await checkPropagation('restored-closed', closed);
        const final = await inspectRelease(closedRuleset, closedSha);
        journal.event('closed', final);
        canUnlock = true;
      } finally {
        if (canUnlock) {
          await service.releaseLock(version);
          journal.event('released', { runId, version });
        }
      }
    }
  }
  return result;
}
