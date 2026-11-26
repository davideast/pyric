import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { manifest, sha } from '../../corpus.mjs';
import { withRelease, withPreparedRuleset } from './release.mjs';

const closed = manifest.target.closedRuleset;
const open = 'projects/' + manifest.target.project + '/rulesets/test-candidate';
function mock() {
  const history = [];
  const state = { current: closed, locked: false };
  const service = {
    async preflight() { return { release: { rulesetName: closed }, config: {}, projectNumber: '1' }; },
    async takeLock() { state.locked = true; return 'v1'; },
    async recoverLock() {},
    async verifyLease() { assert.ok(state.locked, 'lock lost'); },
    async currentRelease() { return { rulesetName: state.current }; },
    async switchRelease(name) { history.push(name); state.current = name; },
    async releaseLock() { await this.verifyLease(); state.locked = false; history.push('unlock'); },
    async inspect(id, version, name, digest) {
      await this.verifyLease();
      assert.equal(version, 'v1');
      assert.equal(state.current, name);
      return { rulesetName: name, rulesSha256: digest };
    },
    async uploadRules() { return open; },
  };
  const options = {
    runId: randomUUID(), source: 'stock', digest: sha('stock'), journal: { event() {} }, checkStop() {},
    async setupClients() {},
    async checkPropagation(phase) { history.push(phase); return sha('observed'); },
    async capture(verify) { return verify(); },
  };
  return { service, options, state, history };
}

test('activation proof requires data-plane propagation and restoration precedes unlock', async () => {
  const { options, service, history } = mock();
  const proof = await withRelease(options, service);
  assert.equal(proof.rulesSha256, options.digest);
  assert.equal(proof.propagationReceiptSha256, sha('observed'));
  assert.deepEqual(history, ['initially-closed', open, 'open', closed, 'restored-closed', 'unlock']);
});

test('ambiguous activation response still restores the pinned closed release', async () => {
  const { options, service, history } = mock();
  const change = service.switchRelease;
  service.switchRelease = async name => {
    await change(name);
    if (name === open) throw Error('lost response');
  };
  await assert.rejects(withRelease(options, service), /lost response/);
  assert.deepEqual(history, ['initially-closed', open, closed, 'restored-closed', 'unlock']);
});

test('capture failure restores and verifies before releasing the lease', async () => {
  const { options, service, history } = mock();
  options.capture = async () => { throw Error('attempt failed'); };
  await assert.rejects(withRelease(options, service), /attempt failed/);
  assert.deepEqual(history.slice(-3), [closed, 'restored-closed', 'unlock']);
});

test('an unverified restored data plane retains the lease', async () => {
  const { options, service, state } = mock();
  options.checkPropagation = async phase => {
    if (phase === 'restored-closed') throw Error('still open');
    return sha(phase);
  };
  await assert.rejects(withRelease(options, service), /still open/);
  assert.equal(state.current, closed);
  assert.equal(state.locked, true);
});

test('release or lease interference cannot clobber another controller', async () => {
  for (const kind of ['release', 'lease']) {
    const { options, service, state, history } = mock();
    options.capture = async () => {
      if (kind === 'release') state.current = 'foreign';
      else state.locked = false;
    };
    await assert.rejects(withRelease(options, service));
    assert.equal(history.includes(closed), false);
    assert.equal(history.includes('unlock'), false);
  }
});

test('a failed acquisition never releases a foreign lease', async () => {
  const { options, service, history } = mock();
  service.takeLock = async () => { throw Error('lease busy'); };
  await assert.rejects(withRelease(options, service), /lease busy/);
  assert.deepEqual(history, []);
});

test('reusing a previously uploaded source verifies its project, attachment and entire file list before activation', async () => {
  const name='projects/'+manifest.target.project+'/rulesets/'+randomUUID();
  for (const fault of [null,'name','database','content','extra','service']) {
    const {options,service,history}=mock();
    service.uploadRules=()=>{throw Error('unexpected upload');};
    service.getRuleset=async key=>{
      assert.equal(key,name);
      return {name:fault==='name' ? 'another-ruleset' : name,
        attachmentPoint:'firestore.googleapis.com/projects/1/databases/'+(fault==='database'?'other':manifest.target.database),
        source:{files:[{name:'firestore.rules',content:fault==='content'?'wrong':options.source},...(fault==='extra'?[{name:'other',content:'x'}]:[])]},
        metadata:{services:[fault==='service'?'other':'cloud.firestore']}};
    };
    const run=()=>withPreparedRuleset(name,()=>withRelease(options,service));
    if (fault) {
      await assert.rejects(run);
      assert.deepEqual(history,['initially-closed','unlock']);
    } else {
      await run();
      assert.deepEqual(history,['initially-closed',name,'open',closed,'restored-closed','unlock']);
    }
  }
  for(const invalid of [name.replace('/rulesets/','/releases/'),name+'/suffix',name.replace(manifest.target.project,'wrong-project')]) {
    assert.throws(()=>withPreparedRuleset(invalid,()=>assert.fail('invoked foreign source')));
  }
});
