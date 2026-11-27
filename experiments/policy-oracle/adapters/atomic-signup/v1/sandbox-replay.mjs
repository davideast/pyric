// Usage: bun sandbox-replay.mjs <installed project package.json> <live receipt> [stock|get-after]
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {signup} from './fixture.mjs';
import {materialize, sourcePath, seedTime} from '../../invite-profile/v1/fixture.mjs';

const [packageJson, receiptFile, mode] = process.argv.slice(2);
const base = pathToFileURL(resolve(packageJson)).href;
const load = name => import(import.meta.resolve(name, base));
const {initializeSandbox, getClock} = await load('pyric/sandbox');
const {getFirestore, getAdminFirestore, doc, updateDoc, setDoc, getDoc, writeBatch, serverTimestamp, Timestamp} =
  await load('pyric/firestore');
const {setRules} = await load('pyric/sandbox/firestore');
const rules = mode === undefined ? readFileSync(new URL('../../../' + sourcePath, import.meta.url),'utf8')
  : (await import('../../signup-get-after/v1/sources.mjs')).sources[mode];
assert.equal(typeof rules,'string','unknown signup ruleset');
const live = JSON.parse(readFileSync(receiptFile));
const caller = live.identities.claimant.uid, reader = live.identities.reader.uid;
const {paths, attempts} = signup(caller, live.runId);

async function setup() {
  const sandbox = initializeSandbox();
  const clock = getClock(sandbox);
  clock.set(Date.UTC(2026,1,1));
  setRules(sandbox,rules);
  const admin = getAdminFirestore(sandbox);
  await setDoc(doc(admin,'world/config'),{admins:[reader]});
  await setDoc(doc(admin,paths.invite),{createdBy:reader,createdAt:Timestamp.fromDate(new Date(seedTime)),usedBy:null,usedAt:null});
  const client = uid => getFirestore(sandbox.withAuth({uid,token:{}}));
  return {writer:client(caller), observer:client(reader), clock};
}
const results = {};
function compareRead(actual, expected, key) {
  if (expected === null || actual === null) return assert.equal(actual,expected,key);
  assert.deepEqual(Object.keys(actual).sort(),Object.keys(expected).sort(),key);
  for (const [field,value] of Object.entries(expected)) {
    if (value?.type === 'firestore/timestamp/1.0') {
      assert.ok(actual[field] instanceof Timestamp, key + '.' + field);
      if (key === 'invite' && field === 'createdAt') assert.equal(actual[field].toMillis(),Date.parse(seedTime));
    } else assert.deepEqual(actual[field], value, key + '.' + field);
  }
}
for (const sequence of [[attempts[0]],attempts.slice(1)]) {
  const {writer,observer,clock} = await setup();
  let ticks = 0;
  for (const attempt of sequence) {
    const requestTime = Date.UTC(2026,1,1,0,0,++ticks);
    clock.set(requestTime);
    const refs = attempt.writes.map(w => [doc(writer,w.path), materialize(w.data,serverTimestamp())]);
    let decision = 'ALLOW';
    try {
      if (attempt.method === 'writeBatch.commit') {
        const batch = writeBatch(writer);
        batch.update(...refs[0]);
        batch.set(...refs[1]);
        await batch.commit();
      } else if (attempt.method === 'updateDoc') await updateDoc(...refs[0]);
      else await setDoc(...refs[0]);
    } catch (error) {
      if (error.code !== 'permission-denied') throw error;
      decision = 'DENY';
    }
    const readbacks = {};
    for (const [key,path] of Object.entries(paths)) {
      const snap = await getDoc(doc(observer,path));
      readbacks[key] = snap.exists() ? snap.data() : null;
      const write = attempt.writes.find(w => w.path === path);
      if (decision === 'ALLOW' && write) {
        const field = key === 'invite' ? 'usedAt' : 'createdAt';
        assert.equal(readbacks[key][field].toMillis(),requestTime,field);
      }
    }
    results[attempt.id] = {decision,readbacks};
  }
}
const inviteAfterClaim = results['sequential-claim'].readbacks.invite;
const inviteAfterProfile = results['sequential-profile'].readbacks.invite;
assert.deepEqual(JSON.parse(JSON.stringify(inviteAfterProfile)),JSON.parse(JSON.stringify(inviteAfterClaim)));
for (const [id,result] of Object.entries(results)) {
  const caseId = mode === undefined ? id : mode + '-' + id;
  const row = live.rows[caseId];
  assert.equal(result.decision,row.decision,caseId);
  for (const [key,data] of Object.entries(result.readbacks)) compareRead(data,row.after[key].data,key);
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([id,row]) => [id,row.decision]))));
