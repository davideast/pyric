// Verify the generated placements against independently retained production records.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { globSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../adapters/arcade-sdk/v1/fixture.mjs';
import { manifest, versionNs } from '../arcade/corpus.mjs';
const dir = fileURLToPath(new URL('.', import.meta.url));
const checkout = realpathSync(join(dir, '../../..'));
const archive = realpathSync(resolve(process.argv[2]));
assert.ok(archive !== checkout && !archive.startsWith(checkout + sep), 'pass the separate controller archive');
const bytes = path => readFileSync(path);
const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(bytes(path));
const indexes = ['release-evidence.json', ...globSync('*/v*/release-evidence.json', { cwd:dir }).sort()];
const placements = indexes.flatMap(name => Object.entries(read(join(dir,name))));
for (const [mode, spec] of placements) {
  const run = join(archive,spec.runId);
  const completed = read(join(run,'completed.json'));
  const record = bytes(join(archive,spec.receipt + '.json'));
  assert.equal(hash(record), spec.receipt);
  assert.deepEqual(record,bytes(join(dir,spec.localReceipt)));
  let stock;
  if (spec.stockReceipt) {
    const stockBytes = bytes(join(archive,spec.stockReceipt + '.json'));
    assert.equal(hash(stockBytes),spec.stockReceipt);
    stock = JSON.parse(stockBytes).rows;
    assert.deepEqual(Object.keys(stock).sort(),Object.keys(spec.decisions).sort());
  }
  const bundle = hash(bytes(join(dir,spec.bundle)));
  const fixture = hash(bytes(join(dir,spec.fixture)));
  assert.deepEqual(completed,{mode,runId:spec.runId,rulesSha256:bundle,fixtureSha256:fixture,receipt:spec.receipt});
  const receipt = JSON.parse(record);
  assert.equal(receipt.rulesSha256,bundle);
  assert.equal(receipt.fixtureSha256,fixture);
  assert.equal(receipt.runId,spec.runId);
  const events = readdirSync(run).filter(f => /^[0-9]+-/.test(f)).sort().map(f => read(join(run,f)));
  const phases = events.filter(e => e.kind === 'propagation-confirmed').map(e => e.data);
  assert.deepEqual(phases.map(p => p.phase), ['initially-closed','open','restored-closed']);
  assert.equal(phases[1].proof.rulesSha256,bundle);
  for (const p of phases) {
    assert.equal(hash(bytes(join(archive,p.digest + '.json'))),p.digest);
    assert.equal(p.proof.databaseUid,manifest.target.uid);
    if (p.phase !== 'open') assert.equal(p.proof.rulesetName,manifest.target.closedRuleset);
  }
  assert.equal(events.at(-1).kind,'released');
  assert.deepEqual(Object.keys(receipt.rows).sort(),Object.keys(spec.decisions).sort());
  for (const [id,expected] of Object.entries(spec.decisions)) {
    const r = receipt.rows[id];
    if (stock) {
      assert.equal(stock[id].fixtureSha256,fixture);
      assert.equal(stock[id].decision,r.decision);
      const sample = materialize(read(join(dir,spec.fixture)),id,{
        actor:r.actor.uid, reader:r.reader.uid, runId:spec.runId,
      });
      assert.equal(r.path,sample.path);
      assert.equal(r.operation,sample.operation);
      assert.deepEqual(r.proposal,sample.data);
      const storedTime = r.before.data.createdAt;
      assert.equal(BigInt(storedTime.seconds) * 1000000000n + BigInt(storedTime.nanoseconds), versionNs(sample.before.createdAt));
      assert.deepEqual(r.before.data,{...sample.before,createdAt:storedTime});
    }
    for (const deployment of [r.deploymentBefore,r.deploymentAfter]) {
      assert.equal(deployment.rulesSha256,bundle);
      assert.equal(deployment.rulesetName,phases[1].proof.rulesetName);
      assert.equal(deployment.lockRunId,spec.runId);
      assert.equal(deployment.databaseUid,manifest.target.uid);
      assert.equal(deployment.propagationReceiptSha256,phases[1].digest);
    }
    assert.equal(r.endpoint,'firestore.googleapis.com');
    assert.equal(r.database,manifest.target.database);
    assert.equal(r.sdkVersion,manifest.target.sdk);
    assert.notEqual(r.actor.uid,r.reader.uid);
    for (const s of [r.before,r.stored]) {
      assert.deepEqual([s.decision,s.fromCache,s.hasPendingWrites],['ALLOW',false,false]);
    }
    assert.deepEqual(r.firstAfterDocument,r.afterDocument);
    if (r.operation === 'transaction-update') {
      assert.equal(r.writeSubmitted,true);
      assert.deepEqual(r.transactionRead,r.before.data);
    }
    assert.equal(r.decision,expected);
    assert.equal(r.code,expected === 'ALLOW' ? 'ok' : 'permission-denied');
    if (expected === 'DENY') {
      assert.deepEqual(r.stored.data,r.before.data);
      assert.deepEqual(r.afterDocument,r.beforeDocument);
    } else {
      assert.ok(versionNs(r.afterDocument.updateTime) > versionNs(r.beforeDocument.updateTime));
      const stored = r.stored.data;
      if (r.operation !== 'set') assert.deepEqual(stored,{...r.before.data,...r.proposal});
      else assert.deepEqual(stored,{...r.proposal,createdAt:stored.createdAt});
    }
    console.log(mode,id,expected,r.beforeDocument.updateTime,r.afterDocument.updateTime);
  }
  if (mode === 'floor') {
    const [accepted, denied] = [receipt.rows['boost-44ms'],receipt.rows['boost-60ms']];
    assert.deepEqual(accepted.before.data,denied.before.data);
    assert.equal(accepted.stored.data.remaining,0.044);
    assert.equal(denied.proposal.remaining,0.060);
    assert.equal(denied.stored.data.remaining,0);
  }
}
