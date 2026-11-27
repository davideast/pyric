import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {manifest,sha} from '../../../arcade/corpus.mjs';
import {immutable,jsonBytes,privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {retained} from '../../chess/verify/journal.mjs';

const groups=[
  ['two','ab','(a)(b)','$2$1','ba','ab'],
  ['eight','abcdefgh','(a)(b)(c)(d)(e)(f)(g)(h)','$8$1','ha','ah'],
  ['twelve','abcdefghijkl','(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)','$12$10$11','ljk','jkl'],
  ['left','aa','(a)(a)|(b)(b)','$1$3$2$4','aa','bb'],
  ['right','bb','(a)(a)|(b)(b)','$1$3$2$4','bb','aa'],
];
const source=["rules_version = '2';",'service cloud.firestore {',
  '  match /databases/{database}/documents/diagnostics/{kind}/answers/{answer} {',
  '    allow get: if '+groups.map(([id,text,pattern,replacement])=>
    "(kind == '"+id+"' && '"+text+"'.replace('"+pattern+"', '"+replacement+"') == answer)").join('\n      || ')+';',
  '  }','}',''].join('\n');
const testCases=groups.flatMap(([id,,,,yes,no])=>[[yes,'ALLOW'],[no,'DENY']].map(([value,expectation])=>({
  expectation,request:{method:'get',path:'/databases/'+manifest.target.database+'/documents/diagnostics/'+id+'/answers/'+value},
})));
const request={source:{files:[{name:'firestore.rules',content:source}]},testSuite:{testCases}};
const endpoint='https://firebaserules.googleapis.com/v1/projects/'+manifest.target.project+':test';
function summary(raw) {
  assert.equal(raw.endpoint,endpoint);
  assert.deepEqual(raw.request,request);
  const results=raw.response.testResults??[];
  if(results.length) assert.equal(results.length,testCases.length);
  return {authority:'Google Rules Test API synthetic get',sourceSha256:sha(source),httpStatus:raw.status,
    results:results.map((result,i)=>({group:groups[Math.floor(i/2)][0],expected:testCases[i].expectation,state:result.state})),
    compileErrors:(raw.response.issues??[]).filter(i=>i.severity==='ERROR').map(i=>i.description),caseWrites:0,releasesActivated:0};
}
const [archiveArg,receiptArg]=process.argv.slice(2),archive=privateArchive(archiveArg);
if(receiptArg) {
  console.log(JSON.stringify(summary(retained(archive,receiptArg)),null,2));
} else {
  const token=execFileSync('gcloud',['auth','print-access-token'],{encoding:'utf8'}).trim();
  const result=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
    headers:{Authorization:'Bearer '+token,'x-goog-user-project':manifest.target.project,'content-type':'application/json'},body:JSON.stringify(request)});
  const raw={endpoint,request,status:result.status,response:await result.json()},bytes=jsonBytes(raw),receipt=sha(bytes);
  immutable(join(archive,receipt+'.json'),bytes,{identicalOk:true});
  const publicEntry={receipt,...summary(raw)},target=new URL('synthetic/',import.meta.url);
  mkdirSync(target,{recursive:true});
  immutable(new URL(receipt+'.json',target),jsonBytes(publicEntry),{identicalOk:true});
  console.log(JSON.stringify(publicEntry,null,2));
}
