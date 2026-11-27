import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {initializeApp,deleteApp,SDK_VERSION} from 'firebase/app';
import {initializeAuth,inMemoryPersistence,signInAnonymously,getIdTokenResult,deleteUser} from 'firebase/auth';
import {getStorage,ref,uploadBytes,getBytes,deleteObject} from 'firebase/storage';
import {startJournal,withMonotonicEvidenceClock,now as stamp} from './archive.mjs';
import {checkIdentity} from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import {cases,bucketFor,project,number,bytes,marker,transport,seed,control,closed,probePath,revision} from '../../../adapters/ai-jrpg-clips/v1/fixture.mjs';

const runId = randomUUID(), bucket = bucketFor(runId);
const archive = startJournal(process.argv[2],runId);
const sha = data=>createHash('sha256').update(data).digest('hex');
const rulesText = readFileSync(new URL('../../../'+probePath+'/storage.rules',import.meta.url),'utf8');
const releaseName = 'projects/'+project+'/releases/firebase.storage/'+bucket;
const gcs = 'https://storage.googleapis.com/storage/v1/b';
const adminApi = 'https://firebaserules.googleapis.com/v1/';
const fb = 'https://firebasestorage.googleapis.com/v1beta/projects/'+number+'/buckets/'+bucket;
const token = execFileSync('gcloud',['auth','print-access-token'],{encoding:'utf8'}).trim();
const signedApps = [], users = [], clients = {};
const record = {runId,revision,project,number,bucket,releaseName,sdk:SDK_VERSION,endpoint:'firebasestorage.googleapis.com',
  rulesSha256:sha(rulesText),closedSha256:sha(closed),rows:{},phases:{}};
let created = false, linked = false, managedRelease = false, activeRules, closedRules;
const createdRulesets = [];

async function call(url,{method='GET',body,missing=false,media=false,contentType='application/json'}={}) {
  assert.ok(['storage.googleapis.com','firebaserules.googleapis.com','firebase.googleapis.com',
    'firebasestorage.googleapis.com'].includes(new URL(url).hostname));
  const response = await fetch(url,{method,headers:{Authorization:'Bearer '+token,'x-goog-user-project':project,
    ...(body === undefined ? {} : {'content-type':contentType})},redirect:'error',signal:AbortSignal.timeout(45_000),
    body:body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)});
  if (missing && response.status === 404) return null;
  if (!response.ok) {
    const info = await response.json().catch(()=>({}));
    throw Error([method,new URL(url).pathname,response.status,info.error?.status,info.error?.message].join(' '));
  }
  if (media) return Buffer.from(await response.arrayBuffer());
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}
async function ownership() {
  const b = await call(gcs+'/'+bucket);
  assert.equal(b.name,bucket);
  assert.equal(b.projectNumber,number);
  assert.equal(b.labels?.pyric_oracle,runId.replaceAll('-',''));
  assert.equal(b.iamConfiguration.publicAccessPrevention,'enforced');
  assert.equal(b.iamConfiguration.uniformBucketLevelAccess.enabled,true);
  return b;
}
async function release() { return call(adminApi+releaseName,{missing:true}); }
async function makeRules(source) {
  const rules = await call(adminApi+'projects/'+project+'/rulesets',{method:'POST',body:{
    source:{files:[{name:'storage.rules',content:source}]}}});
  assert.match(rules.name,/^projects\/digame-mas\/rulesets\/[a-f0-9-]{36}$/);
  createdRulesets.push(rules.name);
  return rules.name;
}
async function setRelease(rulesetName) {
  assert.ok(createdRulesets.includes(rulesetName));
  await ownership();
  const current = await release();
  if (current) {
    assert.ok(managedRelease && createdRulesets.includes(current.rulesetName),'unexpected release');
    await call(adminApi+releaseName,{method:'PATCH',body:{release:{name:releaseName,rulesetName}}});
  } else {
    await call(adminApi+'projects/'+project+'/releases',{method:'POST',body:{name:releaseName,rulesetName}});
  }
  managedRelease = true;
}
async function proof(rulesetName,source) {
  const [rel,rules,b] = await Promise.all([release(),call(adminApi+rulesetName),ownership()]);
  assert.equal(rel.name,releaseName);
  assert.equal(rel.rulesetName,rulesetName);
  assert.equal(rules.name,rulesetName);
  assert.deepEqual(rules.source.files,[{name:'storage.rules',content:source}]);
  return {at:stamp(),name:rel.name,rulesetName,rulesSha256:sha(source),updateTime:rel.updateTime,
    bucketId:b.id,bucketCreated:b.timeCreated,projectNumber:b.projectNumber};
}
function objectUrl(path) {
  assert.ok(path === marker || path === transport || cases.some(c=>c.path === path));
  return gcs+'/'+bucket+'/o/'+encodeURIComponent(path);
}
async function readback(path) {
  const url = objectUrl(path);
  const o = await call(url+'?fields=bucket,name,size,contentType,generation,metageneration,updated',{missing:true});
  if (!o) return null;
  const data = await call(url+'?alt=media&generation='+encodeURIComponent(o.generation),{media:true});
  assert.equal(String(data.length),o.size);
  return {...o,sha256:sha(data)};
}
async function attempt(actor,op,path,size,mime,salt) {
  const target = ref(clients[actor],path);
  try {
    if (op === 'upload') {
      const result = await uploadBytes(target,bytes(size,salt),{contentType:mime});
      return {decision:'ALLOW',code:'ok',sdkResult:{generation:result.metadata.generation,
        size:result.metadata.size,contentType:result.metadata.contentType}};
    }
    if (op === 'delete') { await deleteObject(target); return {decision:'ALLOW',code:'ok'}; }
    assert.equal(op,'read');
    const data = Buffer.from(await getBytes(target));
    return {decision:'ALLOW',code:'ok',sdkResult:{size:data.length,sha256:sha(data)}};
  } catch (error) {
    if (!['storage/unauthorized','storage/unauthenticated'].includes(error.code)) throw error;
    return {decision:'DENY',code:error.code};
  }
}
async function propagation(key,name,source) {
  const expected = ['open','control'].includes(key) ? 'ALLOW' : 'DENY';
  const deployment = await proof(name,source), streak = [];
  for (let n=0;n<65;n++) {
    const got = await attempt('signed','read',marker);
    if (got.decision === expected) streak.push({...got,at:stamp()});
    else streak.length = 0;
    if (streak.length === 2) {
      record.phases[key] = {deployment,probes:streak};
      archive.event('phase-'+key,record.phases[key]);
      return;
    }
    await delay(3000);
  }
  throw Error(key+' release propagation timed out');
}
async function setupApps() {
  const base = 'https://firebase.googleapis.com/v1beta1/projects/'+project;
  const apps = await call(base+'/webApps?pageSize=100');
  const entry = apps.apps.find(a=>a.displayName === 'pyric-arcade');
  assert.ok(entry,'sandbox web app missing');
  const config = await call('https://firebase.googleapis.com/v1beta1/'+entry.name+'/config');
  assert.equal(config.projectId,project);
  for (const actor of ['signed','out']) {
    const app = initializeApp(config,runId+'-'+actor);
    signedApps.push(app);
    const auth = initializeAuth(app,{persistence:inMemoryPersistence});
    if (actor === 'signed') {
      const {user} = await signInAnonymously(auth);
      users.push(user);
      const {claims,signInProvider} = await getIdTokenResult(user);
      record.identity = {uid:user.uid,audience:claims.aud,issuer:claims.iss,provider:signInProvider};
      checkIdentity(record.identity);
    } else {
      await auth.authStateReady();
      assert.equal(auth.currentUser,null);
    }
    const storage = getStorage(app,'gs://'+bucket);
    storage.maxOperationRetryTime = 15_000;
    storage.maxUploadRetryTime = 15_000;
    clients[actor] = storage;
  }
}
async function seedObject(path,data,contentType) {
  await call('https://storage.googleapis.com/upload/storage/v1/b/'+bucket+'/o?uploadType=media&ifGenerationMatch=0&name='+encodeURIComponent(path),
    {method:'POST',body:data,contentType});
  return readback(path);
}
async function capture() {
  assert.equal(await call(gcs+'/'+bucket,{missing:true}),null);
  assert.equal(await release(),null);
  await call(gcs+'?project='+project,{method:'POST',body:{name:bucket,location:'US',
    labels:{pyric_oracle:runId.replaceAll('-','')},
    iamConfiguration:{publicAccessPrevention:'enforced',uniformBucketLevelAccess:{enabled:true}},
    softDeletePolicy:{retentionDurationSeconds:'0'}}});
  created = true;
  const b = await ownership();
  record.bucketCreated = b.timeCreated;
  archive.event('created',{bucket,runId,timeCreated:b.timeCreated});
  await call(fb+':addFirebase',{method:'POST'});
  linked = true;
  assert.equal((await call(fb)).name,'projects/'+number+'/buckets/'+bucket);
  assert.equal(await release(),null,'unexpected auto-created release on fresh bucket');
  await setupApps();
  closedRules = await makeRules(closed);
  await setRelease(closedRules);
  record.marker = await seedObject(marker,bytes(91,7),'audio/wav');
  record.seed = await seedObject(seed.path,bytes(seed.size,seed.salt),seed.mime);
  await propagation('initial',closedRules,closed);
  const transportRules = await makeRules(control);
  await setRelease(transportRules);
  await propagation('control',transportRules,control);
  const upload = await attempt('signed','upload',transport,seed.size,seed.mime,seed.salt);
  archive.event('transport-upload',upload);
  assert.equal(upload.decision,'ALLOW','signed SDK transport control refused');
  record.transport = {upload,stored:await readback(transport)};
  // Re-close between two rulesets that both allow the marker read. A fresh
  // re-opening verifies the exact test release reached the data plane.
  await setRelease(closedRules);
  await propagation('armed',closedRules,closed);
  activeRules = await makeRules(rulesText);
  await setRelease(activeRules);
  await propagation('open',activeRules,rulesText);
  await delay(60_000);
  record.before = await proof(activeRules,rulesText);
  for (const c of cases) {
    const before = await readback(c.path);
    const at = stamp();
    const result = await attempt(c.actor,c.op,c.path,c.size,c.mime,c.salt);
    const after = await readback(c.path);
    record.rows[c.id] = {...c,actorUid:c.actor === 'signed' ? record.identity.uid : null,
      before,at,...result,after,finishedAt:stamp()};
    archive.event('scored',record.rows[c.id]);
    console.log(c.id,result.decision);
  }
  const sentinel = await attempt('signed','read',marker);
  assert.equal(sentinel.decision,'ALLOW');
  record.after = {deployment:await proof(activeRules,rulesText),marker:sentinel};
}
async function cleanup() {
  if (created) {
    await ownership();
    if (managedRelease) {
      const live = await release();
      if (live?.rulesetName !== closedRules) await setRelease(closedRules);
      if (record.marker && clients.signed) await propagation('restored',closedRules,closed);
      await proof(closedRules,closed);
    }
    const prefix = gcs+'/'+bucket+'/o';
    const listing = await call(prefix+'?fields=items(name,generation),nextPageToken');
    assert.ok(!listing.nextPageToken);
    for (const o of listing.items ?? []) {
      await call(objectUrl(o.name)+'?ifGenerationMatch='+encodeURIComponent(o.generation),{method:'DELETE'});
    }
    if (managedRelease) {
      assert.equal((await release()).rulesetName,closedRules);
      await call(adminApi+releaseName,{method:'DELETE'});
    }
    if (linked) await call(fb+':removeFirebase',{method:'POST'});
    const b = await ownership();
    await call(gcs+'/'+bucket+'?ifMetagenerationMatch='+encodeURIComponent(b.metageneration),{method:'DELETE'});
    assert.equal(await call(gcs+'/'+bucket,{missing:true}),null);
    assert.equal(await release(),null);
    for (const name of createdRulesets) await call(adminApi+name,{method:'DELETE'});
    record.cleanup = {bucket:'absent',release:'absent',at:stamp()};
    archive.event('cleaned',record.cleanup);
  }
}
await withMonotonicEvidenceClock(async () => {
  try {
    try { await capture(); } finally { await cleanup(); }
  } finally {
    for (const user of users) await deleteUser(user);
    for (const app of signedApps) await deleteApp(app);
  }
});
const digest = archive.retain(record);
archive.complete({runId,digest});
console.log('Completed',runId,digest);
