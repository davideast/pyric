import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {manifest, sha, versionNs} from '../../../arcade/corpus.mjs';
import {databasePath, releaseName, wireFields, checkIdentity} from '../../arcade-sdk/v1/evidence.mjs';
import {hashes, revision, roles, operations, configFor, event, profile, patch} from './fixture.mjs';

const [probe, file] = process.argv.slice(2);
const record = JSON.parse(readFileSync(file));
assert.deepEqual(record.target, manifest.target);
assert.equal(record.sdk, manifest.target.sdk);
assert.equal(record.endpoint, 'firestore.googleapis.com');
assert.equal(record.revision, revision);
assert.match(record.runId, /^[a-f0-9-]{36}$/);
const {actor, owner, runId} = record;
checkIdentity(actor); checkIdentity(owner);
assert.notEqual(actor.uid, owner.uid);

function deployment(proof, name, digest, lease) {
  assert.equal(proof.releaseName, releaseName);
  assert.equal(proof.rulesetName, name);
  assert.equal(proof.rulesSha256, digest);
  assert.equal(proof.databaseUid, manifest.target.uid);
  assert.equal(proof.lockRunId, runId);
  assert.equal(proof.lockVersion, lease);
}
function document(raw, path, data) {
  if (data === null) return assert.equal(raw, null);
  assert.equal(raw.name, databasePath + '/documents/' + path);
  assert.deepEqual(raw.fields, wireFields(data));
  assert.ok(versionNs(raw.updateTime) >= versionNs(raw.createTime));
}
const decisions = {};
for (const [mode, digest] of Object.entries(hashes)) {
  assert.equal(sha(readFileSync(join(probe, mode + '.rules'))), digest);
  const phases = record.phases[mode];
  const open = phases.open, name = open.proof.rulesetName, lease = open.proof.lockVersion;
  assert.match(name, /^projects\/digame-mas\/rulesets\/[a-f0-9-]{36}$/);
  assert.notEqual(name, manifest.target.closedRuleset);
  for (const phase of ['initially-closed', 'open', 'restored-closed']) {
    const p = phases[phase], closed = phase !== 'open';
    deployment(p.proof, closed ? manifest.target.closedRuleset : name,
      closed ? manifest.files['v1/rules/closed.rules'] : digest, lease);
    assert.deepEqual([p.phase, p.get, p.readerGet, p.write], [phase, ...Array(3).fill(closed ? 'DENY' : 'ALLOW')]);
  }
  const propagationDigest = sha(JSON.stringify(open, null, 2) + '\n');
  for (const role of roles) {
    for (const op of operations) {
      const id = [mode, role, op].join('-'), row = record.rows[id];
      assert.deepEqual([row.mode, row.role, row.op], [mode, role, op]);
      const deleting = op === 'event-delete', before = deleting ? event : profile;
      const path = deleting ? 'events/oracle-' + runId : 'players/' + owner.uid;
      assert.equal(row.path, path);
      const config = configFor(role, actor.uid, owner.uid);
      assert.deepEqual(row.config, config);
      document(row.configBefore, 'world/config', config);
      assert.deepEqual(row.configAfter, row.configBefore);
      for (const proof of [row.deploymentBefore, row.deploymentAfter]) {
        deployment(proof, name, digest, lease);
        assert.equal(proof.propagationReceiptSha256, propagationDigest);
      }
      const times = [phases['initially-closed'].at, open.at, row.deploymentBefore.verifiedAt, row.attemptedAt,
        row.readAt, row.deploymentAfter.verifiedAt, phases['restored-closed'].at].map(versionNs);
      assert.ok(times.every((t,i) => i === 0 || t >= times[i-1]));
      assert.deepEqual(row.before, before);
      document(row.seed, path, before);
      assert.deepEqual(row.proposal, deleting ? null : patch);
      assert.ok(['ALLOW','DENY'].includes(row.decision));
      const allowed = row.decision === 'ALLOW';
      assert.equal(row.code, allowed ? 'ok' : 'permission-denied');
      const after = allowed ? (deleting ? null : {...profile,...patch}) : before;
      assert.deepEqual(row.stored, after);
      document(row.afterDocument, path, after);
      if (!allowed) assert.deepEqual(row.afterDocument, row.seed);
      else if (!deleting) {
        assert.equal(row.afterDocument.createTime, row.seed.createTime);
        assert.ok(versionNs(row.afterDocument.updateTime) > versionNs(row.seed.updateTime));
      }
      decisions[id] = row.decision;
    }
  }
}
assert.deepEqual(Object.keys(record.rows).sort(), Object.keys(decisions).sort());
console.log(JSON.stringify(decisions));
