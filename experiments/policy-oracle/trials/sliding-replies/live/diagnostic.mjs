import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {manifest,sha} from '../../../arcade/corpus.mjs';
import {immutable,privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {retained} from '../../chess/verify/journal.mjs';
import {root,digestPattern,readJSON,verifySource} from './fixtures.mjs';

const endpoint='https://firebaserules.googleapis.com/v1/projects/'+manifest.target.project+':test';
const sample={expectation:'DENY',request:{method:'get',path:'/databases/'+manifest.target.database+'/documents/chess/compile-control'}};
const target=digest=>new URL('diagnostics/'+digest+'/',root);

function body(source) {
  return {source:{files:[{name:'firestore.rules',content:source}]},testSuite:{testCases:[sample]}};
}
function observation(raw) {
  assert.equal(raw.endpoint,endpoint);
  const source=raw.request.source.files[0].content,digest=sha(source);
  assert.deepEqual(raw.request,body(source));
  verifySource(source,digest);
  const issues=(raw.response.issues??[]).map(item=>({severity:item.severity,line:item.sourcePosition?.line??null,
    column:item.sourcePosition?.column??null,message:item.description.split(' Pattern: ')[0]}));
  let state;
  if(raw.status===200 && !issues.some(i=>i.severity==='ERROR')) {
    assert.deepEqual(raw.response.testResults?.map(x=>x.state),['SUCCESS']);state='compiled';
  } else if([200,400].includes(raw.status) && issues.some(i=>i.severity==='ERROR')) state='compile-error';
  else state='service-error';
  return {authority:'Google Rules Test API',rulesSha256:digest,requestSha256:sha(JSON.stringify(raw.request)),
    httpStatus:raw.status,state,issues,caseWrites:0,releasesActivated:0};
}

export function diagnostics(digest,archive) {
  assert.match(digest,digestPattern);const dir=target(digest);
  if(!existsSync(dir)) return [];
  return readdirSync(dir).sort().map(name=>{
    const value=readJSON(new URL(name,dir)),{receipt,...rest}=value;
    assert.match(receipt,digestPattern);assert.equal(name,receipt+'.json');assert.equal(value.rulesSha256,digest);
    assert.equal(value.caseWrites,0);assert.equal(value.releasesActivated,0);
    if(archive) assert.deepEqual(observation(retained(privateArchive(archive),receipt)),rest);
    return value;
  });
}

async function measure(digest,file,archive) {
  const source=readFileSync(file,'utf8');verifySource(source,digest);
  const request=body(source),token=execFileSync('gcloud',['auth','print-access-token'],{encoding:'utf8'}).trim();
  const result=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
    headers:{Authorization:'Bearer '+token,'x-goog-user-project':manifest.target.project,'content-type':'application/json'},
    body:JSON.stringify(request)});
  const raw={endpoint,request,status:result.status,response:await result.json()};
  const value=observation(raw),privateBytes=Buffer.from(JSON.stringify(raw,null,2)+'\n'),receipt=sha(privateBytes);
  immutable(join(privateArchive(archive),receipt+'.json'),privateBytes,{identicalOk:true});
  const dir=target(digest);mkdirSync(dir,{recursive:true});
  const bytes=Buffer.from(JSON.stringify({...value,receipt},null,2)+'\n');
  immutable(new URL(receipt+'.json',dir),bytes,{identicalOk:true});
  console.log(JSON.stringify({digest,state:value.state,httpStatus:value.httpStatus,receipt,
    errors:value.issues.filter(i=>i.severity==='ERROR')},null,2));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await measure(...process.argv.slice(2));
