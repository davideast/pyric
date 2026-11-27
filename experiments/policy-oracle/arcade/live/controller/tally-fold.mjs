import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {manifest,sha} from '../../corpus.mjs';
import {api,dbName,dbUrl} from '../control.mjs';
import {clientsFor,createDocument,lite,readDocument,SDK_VERSION} from './clients.mjs';
import {withRelease} from './release.mjs';
import {startJournal,withMonotonicEvidenceClock} from './archive.mjs';
import {wireFields} from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import {fields} from '../../../adapters/ai-jrpg-campaign/v1/values.mjs';
const profile = process.argv[4] ?? 'tally-fold';
assert.ok(['tally-fold','tally-strikes'].includes(profile));
const directory = new URL('../../../adapters/'+profile+'/v1/',import.meta.url);
const {cases,moves} = await import(new URL('fixture.mjs',directory));
const start = profile === 'tally-strikes' ? 89 : 90;

const source = readFileSync(new URL('generated.rules',directory),'utf8');
const digest = sha(source);
assert.equal(digest,process.argv[3], 'review the generated rules before activation');
const runId = randomUUID(), journal = startJournal(process.argv[2],runId);
const clients = clientsFor(runId,journal), owned = new Set();
const receipt = {runId,target:manifest.target,sdk:SDK_VERSION,digest,identities:{},phases:{},rows:{}};
let writer,reader,marker,stop = false;
for (const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>{stop = true;});
const checkStop = () => assert.ok(!stop,'stop requested');
async function decide(action) {
  try { await action(); return 'ALLOW'; } catch (err) {
    if (err.code === 'permission-denied') return 'DENY';
    throw err;
  }
}
async function setupClients(config) {
  writer = await clients.add('writer',config);
  reader = await clients.add('reader',config);
  receipt.identities = {writer:writer.identity,reader:reader.identity};
  marker = 'tallyFoldControls/'+writer.identity.uid;
}
async function checkPropagation(phase,proof) {
  const open = phase === 'open', wanted = open ? 'ALLOW' : 'DENY';
  const ref = lite.doc(writer.lite,marker);
  for (let i = 0, streak = 0; i < 100; i++) {
    const write = await decide(()=>lite.setDoc(ref,{runId}));
    if (write === 'ALLOW') owned.add(marker);
    let stored;
    const read = await decide(async ()=>{
      const snapshot = await lite.getDoc(ref);
      stored = snapshot.data();
      if (stored) assert.deepEqual(stored,{runId});
    });
    streak = read === wanted && write === wanted && (!open || stored?.runId === runId) ? streak + 1 : 0;
    if (streak === 2) {
      const result = {phase,proof,read,write};
      receipt.phases[phase] = result;
      journal.event('propagation-confirmed',result);
      return journal.retain(result);
    }
    await delay(3000);
  }
  throw Error('propagation timed out in '+phase);
}
async function snapshot(path) {
  let sdk;
  for (let i = 0; ; i++) {
    try { sdk = await lite.getDoc(lite.doc(reader.lite,path)); break; }
    catch (err) {
      if (i >= 19 || !['permission-denied','unavailable','deadline-exceeded'].includes(err.code)) throw err;
      journal.event('read-retry',{path,attempt:i+1,code:err.code});
      await delay(3000);
    }
  }
  const document = await readDocument(path);
  assert.equal(document.name,dbName+'/documents/'+path);
  assert.deepEqual(fields(document),sdk.data());
  return {data:sdk.data(),document};
}
async function capture(verify) {
  await delay(100_000);
  receipt.beforeProof = await verify();
  for (const c of cases) {
    checkStop();
    const path = 'tallyFolds/'+runId+'-'+c.id;
    const seed = {owner:writer.identity.uid,reader:reader.identity.uid,tally:start,moves:[]};
    const submitted = {tally:c.claim,moves:moves(c)};
    await createDocument(path,wireFields(seed));
    owned.add(path);
    const before = await snapshot(path);
    assert.deepEqual(before.data,seed);
    const decision = await decide(()=>lite.updateDoc(lite.doc(writer.lite,path),submitted));
    const after = await snapshot(path);
    if (decision === 'DENY') assert.deepEqual(after,before);
    else assert.deepEqual(after.data,{...seed,...submitted});
    receipt.rows[c.id] = {path,before,submitted,decision,after};
    journal.event('scored',receipt.rows[c.id]);
    console.log(c.id,decision);
  }
  receipt.afterProof = await verify();
}
await withMonotonicEvidenceClock(async ()=>{
  try { await withRelease({runId,journal,source,digest,setupClients,checkPropagation,capture,checkStop}); }
  finally {
    try {
      for (const path of owned) {
        const doc = await readDocument(path);
        assert.ok(path === marker ? doc.fields.runId.stringValue === runId :
          path.startsWith('tallyFolds/'+runId+'-') && doc.fields.owner.stringValue === writer.identity.uid);
        await api(dbUrl+'/documents:commit','POST',{writes:[{delete:doc.name,currentDocument:{updateTime:doc.updateTime}}]});
      }
    } finally { await clients.close(); }
  }
  journal.complete({runId,digest:journal.retain(receipt)});
  console.log('Completed',runId);
});
