// Create a fresh secondary instance. Every scored request and readback uses
// a Firebase ID token. OAuth is used only for provisioning, seeds and rules.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {initializeApp,deleteApp,SDK_VERSION} from 'firebase/app';
import {initializeAuth,inMemoryPersistence,signInAnonymously,deleteUser,getIdTokenResult} from 'firebase/auth';
import {api} from '../control.mjs';
import {sha} from '../../corpus.mjs';
import {startJournal} from './archive.mjs';
import {fixtures as frameFixtures,seed,stock} from '../../../adapters/air-hockey/v1/fixture.mjs';

const scenario = process.argv[3] ?? 'frame';
function scenarioFixtures() {
  switch (scenario) {
    case 'frame': return frameFixtures;
    case 'winning-goal': return JSON.parse(readFileSync(
      new URL('../../../adapters/air-hockey-winning/v1/frames.json',import.meta.url)));
    case 'moving-serve': return import('../../../adapters/air-hockey-moving-serve/v1/fixture.mjs').then(module => module.fixtures);
    case 'host-serve-side': return import('../../../adapters/air-hockey-host-serve-side/v1/fixture.mjs').then(module => module.fixtures);
    case 'serve-side': return import('../../../adapters/air-hockey-serve-side/v1/fixture.mjs').then(module => module.fixtures);
    case 'guest-win': return JSON.parse(readFileSync(
      new URL('../../../adapters/air-hockey-guest-win/v1/frames.json',import.meta.url)));
    case 'match-win': return import('../../../adapters/air-hockey-match-win/v1/fixture.mjs').then(module => module.fixtures);
    case 'missing-frame': return import('../../../adapters/air-hockey-missing-frame/v1/fixture.mjs').then(module => module.fixtures);
    default: throw new Error('Unknown Air Hockey capture scenario');
  }
}
const fixtures = await scenarioFixtures();
const project = 'digame-mas', number = '803835021738';
const runId = randomUUID(), name = 'pyric-frame-'+runId.slice(0,8);
const journal = startJournal(process.argv[2],runId);
const collection = 'projects/'+number+'/locations/us-central1/instances';
const resource = collection+'/'+name;
const management = 'https://firebasedatabase.googleapis.com/v1beta/';
const url = 'https://'+name+'.firebaseio.com';
const closed = {rules:{'.read':false,'.write':false}};
const generatedFile = ['match-win','guest-win','serve-side','host-serve-side','moving-serve'].includes(scenario) ? 'air-hockey-match-win' : 'air-hockey';
const compiled = readFileSync(new URL('../../../adapters/'+generatedFile+'/v1/generated.json',import.meta.url),'utf8');
const access = execFileSync('gcloud',['auth','print-access-token'],{encoding:'utf8'}).trim();
const owner = {Authorization:'Bearer '+access};
const identities = {}, rows = {}, releases = {};
const cleanup = {};
let created, app, host, config;
const started = new Date().toISOString();
for (const key of ['FIREBASE_AUTH_EMULATOR_HOST','FIREBASE_DATABASE_EMULATOR_HOST','FIREBASE_REALTIME_URL']) assert.ok(!process.env[key]);
async function request(endpoint, method, headers, value) {
  const res = await fetch(endpoint,{method,headers:{...headers,'Content-Type':'application/json'},
    body:value === undefined ? undefined : JSON.stringify(value),redirect:'error',signal:AbortSignal.timeout(30000)});
  return {status:res.status,body:await res.json(),etag:res.headers.get('etag')};
}
function ok(response,operation) {
  if (response.status !== 200) throw Error(operation+' failed: '+response.status+' '+JSON.stringify(response.body).slice(0,300));
  return response.body;
}
async function manage(suffix,method,value) {
  return ok(await request(management+suffix,method,{...owner,'x-goog-user-project':project},value),'instance '+method);
}
async function db(path,method,token,value,etag=false) {
  const endpoint = new URL(url+'/'+path+'.json');
  if (token) endpoint.searchParams.set('auth',token);
  return request(endpoint,method,{...(token ? {} : owner),...(etag ? {'X-Firebase-ETag':'true'} : {})},value);
}
async function rules(value) {
  ok(await db('.settings/rules','PUT',null,value),'deploy rules');
  const active = ok(await db('.settings/rules','GET'),'read rules');
  assert.deepEqual(active,value);
}
try {
  const base = 'https://firebase.googleapis.com/v1beta1/projects/'+project;
  const apps = await api(base+'/webApps?pageSize=100');
  const web = apps.apps.find(a=>a.displayName === 'pyric-arcade');
  assert.ok(web);
  config = await api('https://firebase.googleapis.com/v1beta1/'+web.name+'/config');
  assert.equal(config.projectId,project);
  app = initializeApp(config,runId);
  const auth = initializeAuth(app,{persistence:inMemoryPersistence});
  host = (await signInAnonymously(auth)).user;
  const {claims,token,signInProvider} = await getIdTokenResult(host);
  identities.host = {uid:host.uid,audience:claims.aud,issuer:claims.iss,provider:signInProvider};
  assert.equal(claims.aud,project);
  assert.equal(signInProvider,'anonymous');
  created = await manage(collection+'?databaseId='+name,'POST',{type:'USER_DATABASE'});
  assert.equal(created.name,resource);
  assert.equal(created.databaseUrl,url);
  assert.equal(created.type,'USER_DATABASE');
  journal.event('created',{resource,url});
  assert.equal(ok(await db('','GET'),'empty database'),null);
  await rules(closed);
  const controlPath = 'airhockey/closed-control/'+host.uid;
  const denied = async () => {
    const r = await db(controlPath,'GET',token);
    assert.equal(r.body.error,'Permission denied'); assert.equal(r.status,401);
    return r;
  };
  const initiallyClosed = await denied();
  journal.event('closed',initiallyClosed);
  for (const [profile,source] of [['stock',stock],['generated',compiled]]) {
    const parsed = JSON.parse(source);
    await rules(parsed);
    for (const [id,fixture] of Object.entries(fixtures)) {
      const key = profile+'-'+id;
      const path = 'airhockey/'+key+'/'+host.uid;
      ok(await db(path,'PUT',null,seed(fixture,'guest-fixture')),'seed');
      const before = await db(path,'GET',token,undefined,true);
      assert.deepEqual(ok(before,'before'),seed(fixture,'guest-fixture'));
      const method = fixture.method === 'update' ? 'PATCH' : 'PUT';
      const reply = await db(path+fixture.path,method,token,fixture.value);
      const after = await db(path,'GET',token,undefined,true);
      ok(after,'after');
      if (reply.status !== 200) { assert.equal(reply.status,401); assert.equal(reply.body.error,'Permission denied'); }
      rows[key] = {path,method,relativePath:fixture.path,submitted:fixture.value,before,reply,after,decision:reply.status === 200 ? 'ALLOW' : 'DENY'};
      journal.event(key,rows[key]);
      console.log(key,rows[key].decision);
    }
    assert.deepEqual(ok(await db('.settings/rules','GET'),'active rules'),parsed);
    releases[profile] = {sourceSha256:sha(source),activeRulesMatchedBeforeAndAfter:true};
  }
  await rules(closed);
  cleanup.closed = await denied();
} finally {
  try {
    if (created?.name === resource && created.type === 'USER_DATABASE' && created.databaseUrl === url) {
      // Only this run can have successfully created this unique instance.
      try { await rules(closed); }
      finally {
        const disabled = await manage(resource+':disable','POST',{});
        assert.equal(disabled.state,'DISABLED');
        const deleted = await manage(resource,'DELETE');
        assert.equal(deleted.state,'DELETED'); cleanup.instance = deleted;
        journal.event('deleted',deleted);
      }
    }
  } finally {
    try { if (host) { await deleteUser(host); cleanup.identityDeleted = true; } }
    finally { if (app) await deleteApp(app); }
  }
}
const receipt = {runId,started,finished:new Date().toISOString(),project,created,sdk:SDK_VERSION,identities,releases,rows,cleanup};
const digest = journal.retain(receipt);
journal.complete({runId,digest});
console.log('Retained',runId,digest);
