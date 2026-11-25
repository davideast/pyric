import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeApp, deleteApp, SDK_VERSION } from 'firebase/app';
import { initializeAuth, inMemoryPersistence, signInAnonymously, getIdTokenResult, deleteUser } from 'firebase/auth';
import { initializeFirestore, doc, getDocFromServer, Timestamp, terminate, setLogLevel } from 'firebase/firestore';
import { getFirestore as getLite, doc as liteDoc, getDoc as readLite, setDoc as writeLite, setLogLevel as liteLogLevel, Timestamp as LiteTimestamp } from 'firebase/firestore/lite';
import { manifest, manifestDigest, materialize, read, root, verifyInputs, versionNs } from '../corpus.mjs';
import { api, dbName, dbUrl, preflight, currentRelease, switchRelease, uploadRules, takeLock, releaseLock } from './control.mjs';

verifyInputs();
assert.equal(SDK_VERSION, manifest.target.sdk);
assert.equal(process.argv.length, 2);
for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) assert.ok(!process.env[key], key);
setLogLevel('silent');
liteLogLevel('silent');
const runId = randomUUID();
const directory = root + 'records/' + runId;
mkdirSync(directory, { recursive: true, mode: 0o700 });
const receiptPath = directory + '/production.json';
const now = () => new Date().toISOString();
const report = {
  ...manifest.target, manifestDigest, endpoint: 'firestore.googleapis.com', runId, startedAt: now(),
  users: {}, deployments: [], readiness: [], cases: [], cleanup: {},
};
function save() {
  writeFileSync(receiptPath + '.tmp', JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  renameSync(receiptPath + '.tmp', receiptPath);
}
console.log('Production journal:', receiptPath);
save();
const clients = {};
const apps = [];
const cases = manifest.cases.filter(c => c.id.startsWith('four/'));
const pathFor = c => 'tictactoe/' + runId + '-' + c.id.split('/').slice(1).join('-');
const probe = pathFor(cases[0]);
const target = manifest.target;
let lockVersion, original, active, changed = false, restored = false;

async function player(role, config) {
  const app = initializeApp(config, runId + '-' + role);
  apps.push(app);
  const auth = initializeAuth(app, {persistence: inMemoryPersistence});
  const { user } = await signInAnonymously(auth);
  clients[role] = {user};
  const {claims, signInProvider} = await getIdTokenResult(user);
  assert.equal(claims.sub, user.uid);
  assert.equal(claims.aud, target.project);
  assert.equal(claims.iss, 'https://securetoken.google.com/' + target.project);
  assert.equal(signInProvider, 'anonymous');
  const db = initializeFirestore(app, {host:'firestore.googleapis.com', ssl:true}, target.database);
  Object.assign(clients[role], {db, lite: getLite(app, target.database)});
  report.users[role] = {uid:user.uid, issuer:claims.iss, audience:claims.aud, provider:signInProvider};
  save();
}

function wire(value) {
  if (value?.type === 'firestore/timestamp/1.0') return {timestampValue: new Timestamp(value.seconds, value.nanoseconds).toDate().toISOString().replace('.000Z','Z')};
  if (typeof value === 'string') return {stringValue:value};
  if (Number.isSafeInteger(value)) return {integerValue:String(value)};
  assert.ok(value && typeof value === 'object');
  return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([k,v]) => [k,wire(v)]))}};
}
async function snapshot(path) {
  const snap = await getDocFromServer(doc(clients.guest.db,path));
  assert.ok(snap.exists());
  assert.equal(snap.metadata.fromCache,false);
  assert.equal(snap.metadata.hasPendingWrites,false);
  return JSON.parse(JSON.stringify(snap.data()));
}
async function observeAccess(variant, expected) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < 240000) {
    attempts++;
    let outcome;
    try {
      const value = await readLite(liteDoc(clients.guest.lite,probe));
      assert.ok(value.exists());
      outcome = 'ALLOW';
    } catch (e) {
      if (e.code !== 'permission-denied' && e.code !== 'unavailable') throw e;
      outcome = e.code === 'permission-denied' ? 'DENY' : 'unavailable';
    }
    if (outcome === expected) {
      report.readiness.push({variant, actual:outcome, probe, attempts, at:now()});
      save();
      return;
    }
    await delay(2000);
  }
  throw new Error('SDK propagation timeout: ' + variant + ' ' + expected);
}
// A successful read is identical under all four open releases. Counter-zero
// writes have a production baseline and distinguish the +1 and +2 releases.
async function checkWritePropagation(variant) {
  const delta = ['stock','generated'].includes(variant) ? 1 : 2;
  const identities = {host:clients.host.user.uid, guest:clients.guest.user.uid};
  const start = Date.now();
  let consecutive = 0;
  while (Date.now() - start < 180000) {
    const decisions = [];
    for (const count of [1,2]) {
      const control = {id:'zero/'+variant+'/probe', count};
      const {before,proposal} = materialize(control,identities);
      const path = 'tictactoe/'+runId+'-probe-'+randomUUID();
      await api(dbUrl+'/documents/tictactoe?documentId='+path.split('/')[1],'POST',wire(before).mapValue);
      let decision = 'ALLOW';
      try { await writeLite(liteDoc(clients.host.lite,path),{...proposal,createdAt:new LiteTimestamp(before.createdAt.seconds,0)}); }
      catch(e) { if(e.code !== 'permission-denied') throw e; decision = 'DENY'; }
      const stored = await snapshot(path);
      assert.deepEqual(stored,decision === 'ALLOW' ? proposal : before);
      decisions.push(decision);
      report.writeProbes.push({variant,count,decision,path,before,proposal,stored,at:now()});
      save();
    }
    const expected = delta === 1 ? ['ALLOW','DENY'] : ['DENY','ALLOW'];
    consecutive = decisions.every((v,i) => v === expected[i]) ? consecutive + 1 : 0;
    if (consecutive === 2) return;
    await delay(2500);
  }
  throw new Error('Independent count-zero write propagation timeout: '+variant);
}
async function activate(variant, rulesetName) {
  const live = await currentRelease();
  assert.equal(live.rulesetName, active, 'unexpected concurrent rules release');
  changed = true;
  const released = await switchRelease(rulesetName);
  active = rulesetName;
  report.deployments.push({variant, sha256:manifest.files['v1/rules/'+variant+'.rules'], release:released, verifiedAt:now()});
  save();
  // Give production frontends time to install the named release. Still verify
  // both client transports after this interval; elapsed time earns no credit.
  if (variant !== 'closed') await delay(65000);
  await observeAccess(variant, variant === 'closed' ? 'DENY' : 'ALLOW');
  if (variant !== 'closed') await checkWritePropagation(variant);
}
async function attempt(c, identities) {
  const {variant, before, proposal} = materialize(c,identities);
  const path = pathFor(c);
  const baseline = await snapshot(path);
  assert.deepEqual(baseline,before);
  const previous = await api(dbUrl+'/documents/'+path);
  assert.deepEqual(previous.fields,wire(before).mapValue.fields);
  const row = {id:c.id, variant, path, role:c.role, uid:identities[c.role], before:baseline, proposal, attemptedAt:now()};
  report.cases.push(row);
  save();
  try {
    await writeLite(liteDoc(clients[c.role].lite,path), {
      ...proposal, createdAt:new LiteTimestamp(proposal.createdAt.seconds, proposal.createdAt.nanoseconds),
    });
    row.decision = 'ALLOW';
    row.code = 'ok';
  } catch (e) {
    row.decision = e.code === 'permission-denied' ? 'DENY' : 'ERROR';
    row.code = e.code || 'unknown';
  }
  save();
  row.stored = await snapshot(path);
  row.readAt = now();
  const current = await api(dbUrl+'/documents/'+path);
  row.metadata = {fromCache:false,hasPendingWrites:false,beforeVersion:previous.updateTime,afterVersion:current.updateTime};
  save();
  assert.deepEqual(current.fields,wire(row.stored).mapValue.fields);
  assert.deepEqual(row.stored,row.decision === 'ALLOW' ? proposal : before);
  const delta = versionNs(current.updateTime) - versionNs(previous.updateTime);
  assert.ok(row.decision === 'ALLOW' ? delta > 0n : delta === 0n);
  console.log(c.id, row.decision, 'stored', row.stored.moveCount);
}
try {
  const setup = await preflight();
  report.writeProbes = [];
  lockVersion = await takeLock(runId);
  original = setup.release;
  assert.equal((await currentRelease()).rulesetName, original.rulesetName);
  active = original.rulesetName;
  report.initialRelease = original;
  for (const role of ['host','guest']) await player(role,setup.config);
  const identities = {host:clients.host.user.uid, guest:clients.guest.user.uid};
  assert.notEqual(identities.host, identities.guest);
  for (const c of cases) {
    const path = pathFor(c);
    const {before} = materialize(c,identities);
    const seeded = await api(dbUrl+'/documents/tictactoe?documentId='+path.split('/')[1],'POST',wire(before).mapValue);
    assert.equal(seeded.name,dbName+'/documents/'+path);
  }
  await observeAccess('initially closed','DENY');
  for (const variant of ['stock','generated','hand2','plus2']) {
    const file = 'v1/rules/'+variant+'.rules';
    const ruleset = await uploadRules(read(file),setup.projectNumber,manifest.files[file]);
    await activate(variant,ruleset);
    for (const c of cases.filter(c => materialize(c).variant === variant)) await attempt(c,identities);
    if (variant !== 'plus2') await activate('closed', original.rulesetName);
  }
} catch(e) {
  report.failure = e.message;
  console.error('Capture failed:',e.message);
  process.exitCode = 1;
} finally {
  if (changed) {
    try {
      const value = await switchRelease(original.rulesetName);
      report.deployments.push({variant:'closed',sha256:manifest.files['v1/rules/closed.rules'],release:value,verifiedAt:now()});
      await observeAccess('closed at end','DENY');
      report.cleanup.restored = value.rulesetName;
      restored = true;
    } catch(e) { report.cleanup.restoreError = e.message; process.exitCode = 1; }
  }
  if (lockVersion && (!changed || restored)) {
    try { await releaseLock(lockVersion); report.cleanup.lock = 'released'; }
    catch(e) { report.cleanup.lockError = e.message; process.exitCode = 1; }
  }
  for (const [role,{user,db}] of Object.entries(clients)) {
    try { await deleteUser(user); report.cleanup[role] = 'temporary Auth user deleted'; }
    catch(e) { report.cleanup[role] = e.code || 'error'; process.exitCode = 1; }
    if (db) await terminate(db);
  }
  await Promise.all(apps.map(app => deleteApp(app)));
  report.endedAt = now();
  save();
}
if (report.cases.length !== cases.length || report.cases.some((c,i) => c.decision !== cases[i].predicted)) {
  console.error('Incomplete capture or disagreement. See original observations in', receiptPath);
  process.exitCode = 1;
}
