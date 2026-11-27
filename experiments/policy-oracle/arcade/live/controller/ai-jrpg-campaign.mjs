import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {initializeApp,deleteApp} from 'firebase/app';
import {initializeAuth,inMemoryPersistence,EmailAuthProvider,linkWithCredential,getIdTokenResult} from 'firebase/auth';
import {manifest,sha} from '../../corpus.mjs';
import {api,dbUrl,dbName} from '../control.mjs';
import {startJournal,withMonotonicEvidenceClock,now} from './archive.mjs';
import {withRelease} from './release.mjs';
import {clientsFor,lite,SDK_VERSION} from './clients.mjs';
import {fixtureApi,variants,rulesFor,revision} from '../../../adapters/ai-jrpg-campaign/v1/catalog.mjs';
import {materialize,raceResult} from '../../../adapters/ai-jrpg-campaign/v1/values.mjs';

const [archive,variant,...selection] = process.argv.slice(2);
const spec = variants[variant];
assert.ok(spec);
const selected = selection.length ? selection : spec.families;
assert.ok(selected.every(f=>spec.families.includes(f)) && new Set(selected).size === selected.length);
const {families} = await fixtureApi(variant);
const source = rulesFor(variant), digest = sha(source), runId = randomUUID();
const journal = startJournal(archive,runId), clients = clientsFor(runId,journal), dbs = {};
const phases = {}, roles = ['a','b','c'], identities = {}, uids = {}, emails = {}, records = {};
const ctx = {uids,emails,runId,variant};
let signedOutApp,marker,originalRoots,stop = false;
for (const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>{stop = true;});
function checkStop() { if (stop) throw Error('stop requested'); }
const docName = path=>dbName+'/documents/'+path;
async function roots() {
  const data = await api(dbUrl+'/documents:listCollectionIds','POST',{pageSize:1000});
  assert.ok(!data.nextPageToken);
  return (data.collectionIds ?? []).filter(x=>x !== 'oracleLocks').sort();
}
async function snapshot(paths) {
  const unique = [...new Set(paths)];
  assert.ok(unique.length && unique.every(p=>p.split('/').length%2 === 0 && p.split('/').every(s=>/^[\w.-]+$/.test(s))));
  const rows = await api(dbUrl+'/documents:batchGet','POST',{documents:unique.map(docName)});
  assert.equal(rows.length,unique.length);
  return Object.fromEntries(unique.map(path=>{
    const row = rows.find(r=>(r.found?.name ?? r.missing) === docName(path));
    assert.ok(row?.readTime);
    return [path,{document:row.found ?? null,readTime:row.readTime}];
  }));
}
async function clean(paths) {
  if (!paths.length) return;
  const docs = Object.values(await snapshot(paths)).map(x=>x.document).filter(Boolean);
  if (docs.length) await api(dbUrl+'/documents:commit','POST',{writes:docs.map(d=>({delete:d.name,currentDocument:{updateTime:d.updateTime}}))});
  assert.ok(Object.values(await snapshot(paths)).every(s=>!s.document));
}
async function setup(config) {
  originalRoots = await roots();
  const exposed = [...source.matchAll(/^\s*match \/(\w+)/gm)].map(m=>m[1]);
  assert.ok(!originalRoots.some(r=>exposed.includes(r)), 'existing application collection in isolated database');
  for (const role of roles) {
    const client = await clients.add(role,config);
    dbs[role] = client.lite;
    identities[role] = client.identity;
    uids[role] = client.identity.uid;
    emails[role] = role+'-'+runId+'@example.invalid';
    if (selected.includes('session-access') && role !== 'c') {
      await linkWithCredential(client.auth.currentUser,EmailAuthProvider.credential(emails[role],randomUUID()+randomUUID()));
      const {claims,signInProvider} = await getIdTokenResult(client.auth.currentUser,true);
      assert.equal(claims.email,emails[role]);
      assert.equal(claims.sub,uids[role]);
      identities[role] = {...client.identity,email:claims.email,provider:signInProvider};
    }
  }
  signedOutApp = initializeApp(config,runId+'-out');
  const auth = initializeAuth(signedOutApp,{persistence:inMemoryPersistence});
  await auth.authStateReady();
  assert.equal(auth.currentUser,null);
  dbs.out = lite.getFirestore(signedOutApp,manifest.target.database);
  marker = variant === 'blocking' ? 'pyric_oracle/'+runId+'/checks/propagation' : 'mapPins/'+uids.a;
  assert.equal((await snapshot([marker]))[marker].document,null);
}
async function attempt(fn) {
  try { return {verdict:'ALLOW',code:'ok',value:await fn() ?? null}; }
  catch (e) {
    if (e.code !== 'permission-denied') throw e;
    return {verdict:'DENY',code:e.code};
  }
}
async function propagate(phase,proof) {
  const expected = phase === 'open' ? 'ALLOW' : 'DENY';
  let streak = 0;
  for (let i=0;i<70;i++) {
    const write = (await attempt(()=>lite.setDoc(lite.doc(dbs.a,marker),{runId}))).verdict;
    const read = await attempt(async()=> (await lite.getDoc(lite.doc(dbs.b,marker))).data());
    streak = write === expected && read.verdict === expected ? streak+1 : 0;
    if (streak && expected === 'ALLOW') assert.deepEqual(read.value,{runId});
    if (streak === 2) {
      phases[phase] = {phase,proof,write,read:read.verdict,at:now()};
      journal.event('propagation-confirmed',phases[phase]);
      return journal.retain(phases[phase]);
    }
    await delay(3000);
  }
  throw Error('propagation timeout '+phase);
}
const payload = data=>materialize(data,lite.serverTimestamp,iso=>lite.Timestamp.fromDate(new Date(iso)));
const json = v=>JSON.parse(JSON.stringify(v));
async function request(step) {
  const db = dbs[step.actor];
  if (step.op === 'query') {
    const filters = (step.filters ?? []).map(([field,op,value])=>lite.where(field,op,value));
    const found = await lite.getDocs(lite.query(lite.collection(db,step.path),...filters));
    return found.docs.map(doc=>({id:doc.id,path:doc.ref.path,data:json(doc.data())})).sort((a,b)=>a.path.localeCompare(b.path));
  }
  const ref = lite.doc(db,step.path);
  if (step.op === 'get') {
    const doc = await lite.getDoc(ref);
    return doc.exists() ? json(doc.data()) : null;
  }
  if (step.op === 'delete') return lite.deleteDoc(ref);
  if (step.op === 'set') return lite.setDoc(ref,payload(step.data));
  assert.equal(step.op,'update');
  return lite.updateDoc(ref,payload(step.data));
}
async function runFamily(family,verify) {
  const steps = families[family](ctx);
  assert.equal(new Set(steps.map(s=>s.id)).size,steps.length);
  const paths = [...new Set(steps.flatMap(s=>s.watch))];
  assert.ok(!paths.includes(marker));
  const seed = await snapshot(paths);
  assert.ok(Object.values(seed).every(s=>!s.document),'fixture must start empty');
  const rows = {};
  try {
    const beforeProof = await verify();
    for (const step of steps) {
      checkStop();
      assert.ok(step.op === 'query' || step.watch.includes(step.path));
      const before = await snapshot(step.watch), started = now();
      let response, race;
      if (step.op === 'race') {
        assert.equal(new Set(step.actors).size,2);
        const promises = step.actors.map(async actor=>{
          const submitted = now();
          const result = await attempt(()=>lite.updateDoc(lite.doc(dbs[actor],step.path),payload(step.dataByActor[actor])));
          return [actor,{submitted,finished:now(),...result}];
        });
        race = Object.fromEntries(await Promise.all(promises));
      } else response = await attempt(()=>request(step));
      const finished = now(), after = await snapshot(step.watch);
      let decision = response?.verdict;
      if (race) decision = raceResult(Object.fromEntries(Object.entries(race).map(([k,v])=>[k,v.verdict])),step.actors,
        after[step.path].document?.fields?.usedBy?.stringValue,uids);
      if (step.op === 'query' && decision === 'ALLOW') decision = {verdict:decision,
        matches:response.value.map(doc=>step.watch.indexOf(doc.path)).sort((a,b)=>a-b)};
      rows[step.id] = {step,before,after,started,finished,decision,...(race ? {race} : {response})};
      journal.event('scored',{family,id:step.id,decision});
    }
    const afterProof = await verify();
    records[family] = {family,variant,runId,revision,target:manifest.target,sdk:SDK_VERSION,endpoint:'firestore.googleapis.com',
      identities,ctx,seed,marker,rows,beforeProof,afterProof,phases};
    console.log(family,steps.length,'SDK cases');
  } finally { await clean(paths); }
}
await withMonotonicEvidenceClock(async()=>{
  try {
    await withRelease({runId,journal,source,digest,setupClients:setup,checkStop,checkPropagation:propagate,
      capture:async verify=>{
        await delay(100000);
        for (const family of selected) await runFamily(family,verify);
      }});
  } finally {
    try { if (marker) await clean([marker]); }
    finally { try { await clients.close(); } finally { if (signedOutApp) await deleteApp(signedOutApp); } }
  }
  assert.deepEqual(await roots(),originalRoots);
  const receipts = Object.fromEntries(Object.entries(records).map(([name,receipt])=>[name,journal.retain(receipt)]));
  journal.complete({runId,receipts});
  console.log('Completed',variant,runId,JSON.stringify(receipts));
});
