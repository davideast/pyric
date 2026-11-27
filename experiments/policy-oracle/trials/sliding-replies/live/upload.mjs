import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {manifest,sha} from '../../../arcade/corpus.mjs';
import {api,preflight} from '../../../arcade/live/control.mjs';
import {immutable,jsonBytes,privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {retained} from '../../chess/verify/journal.mjs';
import {inspectTarget} from './preflight.mjs';
import {versionDirectory,verifySource} from './fixtures.mjs';

const {project,database,uid}=manifest.target;
const prefix='projects/'+project+'/rulesets/';
const endpoint='https://firebaserules.googleapis.com/v1/projects/'+project+'/rulesets';
const stored=digest=>new URL('upload.json',versionDirectory(digest));

function check(raw,digest) {
  const source=raw.request.source.files;
  assert.equal(raw.endpoint,endpoint);
  assert.equal(source.length,1);
  assert.equal(source[0].name,'firestore.rules');
  verifySource(source[0].content,digest);
  const attachment='firestore.googleapis.com/projects/'+raw.projectNumber+'/databases/'+database;
  assert.match(raw.projectNumber,/^\d+$/);
  assert.deepEqual(raw.request,{source:{files:source},attachment_point:attachment});
  const before=raw.before,after=raw.after;
  for(const state of [before,after]) {
    assert.equal(state.databaseUid,uid);
    assert.equal(state.closedRulesSha256,manifest.files['v1/rules/closed.rules']);
    assert.equal(state.activeLease,false);
  }
  assert.equal(after.restoredReleaseVersion,before.restoredReleaseVersion);
  let state, ruleset=null;
  if(raw.status>=200 && raw.status<300) {
    const rule=raw.verified;
    assert.ok(rule.name.startsWith(prefix));
    assert.match(rule.name.slice(prefix.length),/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.equal(rule.name,raw.response.name);
    assert.equal(rule.attachmentPoint,attachment);
    assert.deepEqual(rule.metadata.services,['cloud.firestore']);
    assert.deepEqual(rule.source.files,source);
    ruleset=rule.name;
    state='compiled';
  } else {
    assert.equal(raw.verified,null);
    state=raw.status===400 && raw.response.error?.status==='INVALID_ARGUMENT'?'compile-rejected':'service-error';
  }
  return {authority:'Google Rules create and GET',rulesSha256:digest,requestSha256:sha(JSON.stringify(raw.request)),
    httpStatus:raw.status,state,ruleset,serviceCode:raw.response.error?.status??null,
    previousReleaseVersion:before.restoredReleaseVersion,finalReleaseVersion:after.restoredReleaseVersion,
    releasesActivated:0,caseWrites:0};
}

export function uploadObservation(digest,archive) {
  if(!existsSync(stored(digest))) return null;
  const entry=JSON.parse(readFileSync(stored(digest)));
  const {receipt,...summary}=entry;
  assert.match(receipt,/^[a-f0-9]{64}$/);
  assert.equal(summary.rulesSha256,digest);
  assert.equal(summary.previousReleaseVersion,summary.finalReleaseVersion);
  if(archive) assert.deepEqual(check(retained(privateArchive(archive),receipt),digest),summary);
  return entry;
}

async function create(digest,archivePath) {
  const archive=privateArchive(archivePath),dir=versionDirectory(digest);
  const source=readFileSync(new URL('firestore.rules',dir),'utf8');
  verifySource(source,digest);
  const existing=uploadObservation(digest,archive);
  if(existing) return existing;
  const before=await inspectTarget();
  const {projectNumber}=await preflight();
  const request={source:{files:[{name:'firestore.rules',content:source}]},
    attachment_point:'firestore.googleapis.com/projects/'+projectNumber+'/databases/'+database};
  const token=execFileSync('gcloud',['auth','print-access-token'],{encoding:'utf8'}).trim();
  // A lost create response may still produce a new immutable Google ruleset.
  // Record intent before POST and refuse an automatic second create.
  immutable(join(archive,'sliding-create-'+digest+'.intent.json'),jsonBytes({digest,endpoint,request,before}));
  const result=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),
    headers:{Authorization:'Bearer '+token,'x-goog-user-project':project,'content-type':'application/json'},
    body:JSON.stringify(request)});
  const response=await result.json(),status=result.status;
  immutable(join(archive,'sliding-create-'+digest+'.response.json'),jsonBytes({status,response}));
  let verified=null;
  if(result.ok) {
    assert.ok(typeof response.name==='string' && response.name.startsWith(prefix));
    verified=await api('https://firebaserules.googleapis.com/v1/'+response.name);
  }
  const after=await inspectTarget();
  const raw={endpoint,request,projectNumber,before,status,response,verified,after};
  const summary=check(raw,digest),bytes=jsonBytes(raw),receipt=sha(bytes);
  immutable(join(archive,receipt+'.json'),bytes,{identicalOk:true});
  immutable(stored(digest),jsonBytes({...summary,receipt}),{identicalOk:true});
  return uploadObservation(digest,archive);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [digest,archive,option]=process.argv.slice(2);
  assert.ok(option===undefined || option==='--locate');
  console.log(JSON.stringify(option?await locate(digest,archive):await create(digest,archive),null,2));
}

async function locate(digest,archivePath) {
  const archive=privateArchive(archivePath),intent=join(archive,'sliding-create-'+digest+'.intent.json');
  const original=JSON.parse(readFileSync(intent));
  verifySource(original.request.source.files[0].content,digest);
  const since=new Date(statSync(intent).mtimeMs-60_000).toISOString();
  const records=[],pages=[];
  let token='';
  do {
    const url=new URL(endpoint);
    url.searchParams.set('pageSize','100');
    if(token) url.searchParams.set('pageToken',token);
    const page=await api(url.href);
    pages.push(page);
    for(const item of page.rulesets??[]) {
      assert.ok(item.name.startsWith(prefix));
      assert.ok(Number.isFinite(Date.parse(item.createTime)));
      if(Date.parse(item.createTime)<Date.parse(since)) continue;
      if(item.attachmentPoint && item.attachmentPoint!==original.request.attachment_point) continue;
      const rule=await api('https://firebaserules.googleapis.com/v1/'+item.name);
      if(rule.attachmentPoint===original.request.attachment_point && rule.source.files.length===1 &&
        sha(rule.source.files[0].content)===digest) records.push(rule.name);
    }
    token=page.nextPageToken??'';
  } while(token);
  const observedAt=new Date().toISOString();
  const raw=jsonBytes({since,observedAt,digest,pages,matchingRulesets:records});
  const receipt=sha(raw);
  immutable(join(archive,receipt+'.json'),raw,{identicalOk:true});
  const summary={since,observedAt,pageCount:pages.length,matchingRulesets:records,receipt};
  const folder=new URL('reconciliation/',versionDirectory(digest));
  mkdirSync(folder,{recursive:true});
  immutable(new URL(receipt+'.json',folder),jsonBytes(summary),{identicalOk:true});
  return summary;
}
