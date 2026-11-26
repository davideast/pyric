import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {manifest,sha} from '../../../arcade/corpus.mjs';
import {immutable,privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {retained} from '../../chess/verify/journal.mjs';
import {reviewedPlan} from './fixtures.mjs';

const project=manifest.target.project;
const endpoint='https://firebaserules.googleapis.com/v1/projects/'+project+':test';
const location=new URL('diagnostics/',import.meta.url);
const testCase={expectation:'DENY',request:{method:'get',path:'/databases/'+manifest.target.database+'/documents/chess/compile-control'}};

function subject(name) {
  if(['literal-4096','literal-4097','groups-100','groups-101'].includes(name)) {
    const [kind,count]=name.split('-');
    const pattern=(kind==='groups' ? '(?:a)' : 'a').repeat(Number(count));
    return "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /chess/{id} {\n      allow read: if request.auth != null && id.matches('"+pattern+"');\n    }\n  }\n}\n";
  }
  if(name==='fallback-paired-pawn') {
    const file='paired-pawn-combined-bare-simple-packed-v5.rules';
    const path=process.env.CHESS_SAFETY_ARTEFACTS ? join(process.env.CHESS_SAFETY_ARTEFACTS,file) : new URL('../artefacts/'+file,import.meta.url);
    const source=readFileSync(path,'utf8');
    assert.equal(sha(source),'12c714bb2c32abc6ec3ffc41e15227370829c5313458d4638ab130d764ce475f');
    return source;
  }
  return readFileSync(reviewedPlan(name).bundle,'utf8');
}

function request(source) {return {source:{files:[{name:'firestore.rules',content:source}]},testSuite:{testCases:[testCase]}};}

function normalize(raw) {
  const source=subject(raw.subject);
  assert.equal(raw.endpoint,endpoint);assert.equal(raw.requestSha256,sha(JSON.stringify(request(source))));
  assert.equal(raw.rulesSha256,sha(source));assert.ok([200,400].includes(raw.httpStatus));
  const issues=(raw.response.issues??[]).map(issue=>{
    const [text,pattern]=issue.description.split(' Pattern: ');
    const result={severity:issue.severity,line:issue.sourcePosition?.line,column:issue.sourcePosition?.column,message:text};
    if(pattern) {
      const literal=pattern.endsWith('.')?pattern.slice(0,-1):pattern;
      assert.ok(source.split('\n')[result.line-1].includes("'"+literal+"'"));
      result.literalLength=literal.length;result.literalSha256=sha(literal);
    }
    return result;
  });
  const errors=issues.filter(i=>i.severity==='ERROR');
  const state=errors.length || raw.httpStatus===400 ? 'compile-error' : 'compiled';
  if(state==='compiled')assert.deepEqual(raw.response.testResults?.map(x=>x.state),['SUCCESS']);
  return {authority:'Google Rules Test API',subject:raw.subject,rulesSha256:raw.rulesSha256,requestSha256:raw.requestSha256,
    httpStatus:raw.httpStatus,state,issues,caseWrites:0};
}

export function compileDiagnostics(archive) {
  if(!existsSync(location))return [];
  return readdirSync(location).sort().map(file=>{
    assert.match(file,/^[a-f0-9]{64}\.json$/);
    const value=JSON.parse(readFileSync(new URL(file,location)));
    assert.equal(file,value.rulesSha256+'.json');assert.equal(value.caseWrites,0);
    assert.equal(sha(subject(value.subject)),value.rulesSha256);
    if(archive) {
      const {receipt,...fields}=value;
      assert.deepEqual(normalize(retained(archive,receipt)),fields);
    }
    return value;
  });
}

async function measure(name,archive) {
  const source=subject(name),body=JSON.stringify(request(source));
  const token=execFileSync('gcloud',['auth','print-access-token'],{encoding:'utf8'}).trim();
  const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{Authorization:'Bearer '+token,'x-goog-user-project':project,'content-type':'application/json'},body});
  assert.ok([200,400].includes(response.status),'Google Rules Test API returned '+response.status);
  const raw={subject:name,endpoint,requestSha256:sha(body),rulesSha256:sha(source),httpStatus:response.status,response:await response.json()};
  const value=normalize(raw), bytes=Buffer.from(JSON.stringify(raw,null,2)+'\n'),receipt=sha(bytes);
  immutable(join(archive,receipt+'.json'),bytes,{identicalOk:true});
  const publicBytes=Buffer.from(JSON.stringify({...value,receipt},null,2)+'\n');
  mkdirSync(location,{recursive:true});const path=new URL(value.rulesSha256+'.json',location);
  if(existsSync(path))assert.deepEqual(readFileSync(path),publicBytes);else writeFileSync(path,publicBytes,{flag:'wx'});
  console.log(JSON.stringify({subject:name,state:value.state,errors:value.issues.filter(i=>i.severity==='ERROR')},null,2));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [name,archive]=process.argv.slice(2);await measure(name,privateArchive(archive));
}
