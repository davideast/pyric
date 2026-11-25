import assert from 'node:assert/strict';
import { manifest, manifestDigest, materialize, sha, versionNs } from './corpus.mjs';

// Compare semantic values before aliasing identities. Aliases never repair a
// host/guest swap: the raw documents must contain the two verified live UIDs.
function normalized(data, identities) {
  assert.equal(data.host, identities.host);
  assert.equal(data.guest, identities.guest);
  return {...data, host:'HOST', guest:'GUEST'};
}
export function checkRow(c, row) {
  const {before,proposal} = materialize(c);
  assert.equal(c.id,row.id);
  assert.equal(c.role,row.role);
  assert.deepEqual(before,row.before, c.id+' changed prior state');
  assert.deepEqual(proposal,row.proposal, c.id+' changed proposal');
  assert.equal(row.code,({ALLOW:'ok',DENY:'permission-denied'})[row.decision]);
  assert.ok(['ALLOW','DENY'].includes(row.decision), c.id+' non-verdict');
  assert.deepEqual(row.stored,row.decision === 'ALLOW' ? proposal : before, c.id+' post-state');
  assert.equal(row.metadata.fromCache,false);
  assert.equal(row.metadata.hasPendingWrites,false);
  const diff = versionNs(row.metadata.afterVersion) - versionNs(row.metadata.beforeVersion);
  assert.ok(row.decision === 'ALLOW' ? diff>0n : diff===0n, c.id+' server version');
}
export function checkBatch(batch, receipt) {
  assert.equal(receipt.batch,batch);
  assert.equal(receipt.manifestSha256,manifestDigest);
  assert.equal(receipt.sdk,manifest.target.sdk);
  const expected = manifest.cases.filter(c => c.id.startsWith(batch+'/'));
  assert.deepEqual(receipt.cases.map(r => r.id).sort(), expected.map(c => c.id).sort(), 'missing, extra, or duplicate cases');
  for (const c of expected) {
    const row = receipt.cases.find(r => r.id === c.id);
    const variant = c.id.split('/')[1];
    assert.equal(receipt.rules[variant],manifest.files['v1/rules/'+variant+'.rules'], 'stale rules digest');
    checkRow(c,row);
  }
}
export function importReceipt(batch, bytes) {
  const raw = JSON.parse(bytes);
  const target = manifest.target;
  assert.ok(!raw.failure, 'incomplete run: '+raw.failure);
  assert.equal(raw.project,target.project);
  assert.equal(raw.database,target.database);
  assert.equal(raw.databaseUid ?? raw.uid,target.uid);
  assert.equal(raw.endpoint,'firestore.googleapis.com');
  assert.equal(raw.sdk,target.sdk);
  if(batch==='four') assert.equal(raw.manifestDigest,manifestDigest);
  const identities = {};
  for(const role of ['host','guest']) {
    const user = raw.users[role];
    assert.equal(user.audience,target.project);
    assert.equal(user.issuer,'https://securetoken.google.com/'+target.project);
    assert.equal(user.provider,'anonymous');
    assert.ok(user.uid);
    assert.equal(raw.cleanup[role],'temporary Auth user deleted');
    identities[role] = user.uid;
  }
  assert.notEqual(identities.host,identities.guest);
  const name = 'projects/'+target.project+'/releases/cloud.firestore/'+target.database;
  const rules = {};
  const wanted = batch === 'four' ? ['stock','generated','hand2','plus2'] : ['stock','generated','plus2'];
  const active = raw.deployments.filter(d => d.variant !== 'closed');
  assert.deepEqual(active.map(d => d.variant),wanted);
  for (const d of raw.deployments) {
    assert.equal(d.release.name,name);
    assert.equal(d.sha256,manifest.files['v1/rules/'+d.variant+'.rules']);
    if(d.variant !== 'closed') rules[d.variant] = d.sha256;
  }
  assert.equal(raw.deployments.at(-1).release.rulesetName,target.closedRuleset);
  assert.equal(raw.readiness.at(-1).actual,'DENY');
  assert.equal(raw.readiness.at(-1).variant,'closed at end');
  if (batch==='four') {
    assert.equal(raw.initialRelease.rulesetName,target.closedRuleset);
    assert.equal(raw.cleanup.restored,target.closedRuleset);
    assert.equal(raw.cleanup.lock,'released');
    for(const variant of wanted) {
      const delta = ['stock','generated'].includes(variant)?1:2;
      const controls = raw.writeProbes.filter(p => p.variant === variant).slice(-4);
      assert.deepEqual(controls.map(p => p.count),[1,2,1,2]);
      for(const p of controls) {
        const witness = materialize({id:'zero/'+variant+'/probe',count:p.count},identities);
        assert.equal(p.decision,p.count === delta?'ALLOW':'DENY');
        assert.deepEqual(p.before,witness.before);
        assert.deepEqual(p.proposal,witness.proposal);
        assert.deepEqual(p.stored,p.decision === 'ALLOW'?p.proposal:p.before);
        assert.ok(p.at>=active.find(d=>d.variant===variant).verifiedAt);
      }
      const trial = raw.cases.filter(c => c.variant===variant);
      assert.ok(controls.at(-1).at<=trial[0].attemptedAt);
    }
  }
  const paths = new Set();
  const rows = raw.cases.map(c => {
    assert.ok(!paths.has(c.path)); paths.add(c.path);
    const prefix = 'tictactoe/'+raw.runId+'-'+c.variant+'-';
    assert.ok(c.path.startsWith(prefix),c.path);
    const id = [batch,c.variant,c.path.slice(prefix.length)].join('/');
    if(batch==='four') assert.equal(c.id,id);
    assert.equal(c.uid,identities[c.role]);
    const release = active.find(d=>d.variant===c.variant);
    const closed = raw.deployments[raw.deployments.indexOf(release)+1];
    const ready = raw.readiness.find(r => r.variant===c.variant && r.actual==='ALLOW');
    assert.ok(ready && ready.at>=release.verifiedAt && ready.at<=c.attemptedAt);
    assert.ok(c.attemptedAt<=c.readAt && c.readAt<=closed.verifiedAt);
    return {id,role:c.role,decision:c.decision,code:c.code,
      before:normalized(c.before,identities),proposal:normalized(c.proposal,identities),
      stored:normalized(c.stored,identities),metadata:c.metadata};
  });
  const receipt = {batch,manifestSha256:manifestDigest,rawSha256:sha(bytes),sdk:raw.sdk,
    observedAt:raw.endedAt,rules,cases:rows};
  checkBatch(batch,receipt);
  return receipt;
}
