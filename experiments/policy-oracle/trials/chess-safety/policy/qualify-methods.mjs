import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';

const [pkg,stock,reference]=process.argv.slice(2);
const {compileFunction}=await loadPolicyApi(pkg);
const {compileFunction:base}=await loadPolicyApi(stock);
const {firestoreRules}=await import(pathToFileURL(resolve(reference,'dist/index.js')));
const src=name=>'function probe(value, arg) { return value.'+name+'(arg); }';
const inputs=[
  ['join-empty','join',[],'/',''],['join-empties','join',['','','a'],'|','||a'],
  ['join-unicode','join',['e','🎲'],'/','e/🎲'],['join-two-types','join',[2,false],'-','2-false'],
  ['join-empty-separator','join',['a','b'],'','ab'],
  ['join-null-separator','join',['a'],null],['join-null-receiver','join',null,'x'],
  ['matches-whole','matches','abcd','bc',false],['matches-empty','matches','','',true],
  ['matches-unicode','matches','🎲','.',true],['matches-escaped','matches','a.b','a\\.b',true],
  ['matches-unsupported','matches','ab','(?=a).*'],['matches-invalid-pattern','matches','a','('],
  ['matches-null-pattern','matches','a',null],['matches-null-receiver','matches',null,'.*'],
];
const report=[];
for (const op of ['join','matches']) {
  assert.throws(()=>base(src(op)),/outside the experimental pure expression subset/);
  assert.throws(()=>compileFunction(src(op).replace('(arg)','(arg,arg)')),/outside the experimental pure expression subset/);
  const fn=compileFunction(src(op));
  const body=fn.firestoreModule().replace("rules_version = '2+modules';","").replace('export function','function');
  const rules=firestoreRules("rules_version='2'; service cloud.firestore { match /databases/{db}/documents {"+body+
    " match /probes/{id} {allow create: if probe(request.resource.data.v,request.resource.data.a) == request.resource.data.e;} } }");
  for(const [id,name,v,a,e] of inputs) {
    if(name!==op) continue;
    const outcome=e===undefined ? 'error':'value';
    if(outcome==='error') assert.throws(()=>fn(v,a),undefined,id);
    else assert.deepEqual(fn(v,a),e,id);
    const [r]=rules.simulate([{description:id,method:'create',path:'probes/value',auth:{uid:'w'},
      data:{v,a,e:e??null},expectation:outcome==='error'?'DENY':'ALLOW'}]).cases;
    assert.equal(r.decision,outcome==='error'?'DENY':'ALLOW',id);
    assert.equal(r.trace.some(t=>t.verdict==='ERROR'),outcome==='error',id);
    assert.ok(!r.resourceLimit&&!r.unsupported,id);
    report.push({id,outcome,...(outcome==='value' && {value:e})});
  }
}
console.log(JSON.stringify({authority:'public candidate standalone; independent local Rules evaluation',cases:report},null,2));
