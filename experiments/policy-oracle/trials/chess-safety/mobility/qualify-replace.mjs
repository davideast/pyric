import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';
const [pkg,prior,reference]=process.argv.slice(2);
const {compileFunction}=await loadPolicyApi(pkg);
const {compileFunction:previous}=await loadPolicyApi(prior);
const {firestoreRules}=await import(pathToFileURL(resolve(reference,'dist/index.js')));
const src='function project(text, pattern, template) { return text.replace(pattern, template); }';
assert.throws(()=>previous(src),/outside the experimental pure expression subset/);
const fn=compileFunction(src);
const body=fn.firestoreModule().replace("rules_version = '2+modules';",'').replace('export function','function');
const check=firestoreRules("rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { "+body+
 " match /probes/{id} { allow create: if project(request.resource.data.text, request.resource.data.pattern, request.resource.data.template) == request.resource.data.expected; } } }");
const cases=[
  ['captured-pieces','wk,br,','wk,(br,)','$1wk,','br,wk,'],
  ['captured-empty-group','x,',',()','$1z','xz'],
  ['unmatched','bk,br,','wk,','x','bk,br,'],
  ['repeated','KQkq','[KQ]','','kq'],
  ['literal-dot','a.b','\\.','x','axb'],
  ['unicode','a🎲b','(🎲)','$1$1','a🎲🎲b'],
  ['invalid-backreference','wk','(wk)','$2'],
  ['invalid-pattern','wk','(','x'],
  ['invalid-receiver',null,'a','b'],
  ['invalid-pattern-type','wk',null,'b'],
  ['invalid-template','wk','wk',null],
];
for(const [id,text,pattern,template,answer] of cases) {
  if(answer===undefined) assert.throws(()=>fn(text,pattern,template),undefined,id);
  else assert.equal(fn(text,pattern,template),answer,id);
  const expectation=answer===undefined?'DENY':'ALLOW';
  const [r]=check.simulate([{description:id,path:'probes/value',method:'create',auth:{uid:'writer'},
    data:{text,pattern,template,expected:answer??null},expectation}]).cases;
  assert.equal(r.decision,expectation,id);
  assert.equal(r.trace.some(t=>t.verdict==='ERROR'),answer===undefined,id);
  assert.ok(!r.resourceLimit&&!r.unsupported,id);
}
console.log(JSON.stringify({cases:cases.length,values:cases.filter(r=>r.length===5).length,errors:cases.filter(r=>r.length===4).length},null,2));
