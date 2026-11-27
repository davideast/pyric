import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {attempts, pathsFor, profileData, messageData} from './fixture.mjs';
import {captureTiming} from './timing.mjs';
import {sourcePath} from '../../invite-profile/v1/fixture.mjs';

const [project,receipt] = process.argv.slice(2), live = JSON.parse(readFileSync(receipt));
const timing = captureTiming(live);
const load = name => import(import.meta.resolve(name,pathToFileURL(resolve(project)).href));
const {initializeSandbox,getClock} = await load('pyric/sandbox');
const {setRules} = await load('pyric/sandbox/firestore');
const {doc,getDoc,setDoc,getAdminFirestore,getFirestore,serverTimestamp,Timestamp} = await load('pyric/firestore');
const source = readFileSync(new URL('../../../' + sourcePath,import.meta.url),'utf8');
const uid = live.identities.sender.uid, epoch = Date.UTC(2026,0,1);

function setup() {
  const sandbox = initializeSandbox();
  setRules(sandbox,source);
  const clock = getClock(sandbox);
  clock.set(epoch);
  const client = uid => getFirestore(sandbox.withAuth({uid,token:{}}));
  return {clock,admin:getAdminFirestore(sandbox),writer:client(uid),reader:client(live.identities.reader.uid)};
}
async function submit(fn) {
  try { await fn(); return 'ALLOW'; } catch (error) {
    if (error.code === 'permission-denied') return 'DENY';
    throw error;
  }
}
async function gate(state,paths) {
  return submit(() => setDoc(doc(state.writer,paths.ledger),{lastChatAt:serverTimestamp()},{merge:true}));
}
async function check(state,paths,expected) {
  for (const [key,path] of Object.entries(paths)) {
    const snap = await getDoc(doc(state.reader,path));
    const actual = snap.exists() ? snap.data() : null;
    const liveData = expected[key].data;
    if (liveData === null) { assert.equal(actual,null,key); continue; }
    assert.deepEqual(Object.keys(actual).sort(),Object.keys(liveData).sort());
    for (const [field,value] of Object.entries(liveData)) {
      if (value?.type === 'firestore/timestamp/1.0') assert.ok(actual[field] instanceof Timestamp,field);
      else assert.deepEqual(actual[field],value,field);
    }
  }
}
const results = {};
let state, lastAccepted;
for (const attempt of attempts) {
  const paths = pathsFor(uid,live.runId,attempt.id);
  if (attempt.fresh) {
    state = setup();
    lastAccepted = null;
    const profile = profileData(attempt.profile);
    if (profile) await setDoc(doc(state.admin,paths.profile),profile);
  }
  const at = epoch + (attempt.fresh ? 0 : attempt.id === 'rapid-repeat' ? timing.rapid[0] : timing.recovery[0]);
  state.clock.set(at);
  const row = live.rows[attempt.id];
  await check(state,paths,row.before);
  const ledger = await gate(state,paths);
  if (ledger === 'ALLOW') lastAccepted = at;
  await check(state,paths,row.afterLedger);
  let message = 'NOT_SUBMITTED';
  if (ledger === 'ALLOW') {
    message = await submit(() => setDoc(doc(state.writer,paths.message),messageData(uid,attempt.profile,serverTimestamp())));
  }
  assert.deepEqual({ledger,message},row.decision,attempt.id);
  await check(state,paths,row.after);
  const stored = (await getDoc(doc(state.reader,paths.ledger))).data();
  assert.equal(stored?.lastChatAt.toMillis() ?? null,lastAccepted);
  if (message === 'ALLOW') {
    const storedMessage = (await getDoc(doc(state.reader,paths.message))).data();
    assert.equal(storedMessage.t.toMillis(),at);
  }
  results[attempt.id] = {ledger,message};
}
// Independent reset for each point makes the exact-equality comparison reproducible.
const fixedClock = {};
for (const gap of [1499,1500,1501]) {
  const clean = setup(), paths = pathsFor(uid,'offline','boundary');
  assert.equal(await gate(clean,paths),'ALLOW');
  clean.clock.set(epoch + gap);
  fixedClock[gap] = await gate(clean,paths);
}
console.log(JSON.stringify({results,fixedClock}));
