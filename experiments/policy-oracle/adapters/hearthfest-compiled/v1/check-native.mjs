import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build,artifactPath,nativePath} from './build.mjs';
import {fixture} from './fixture.mjs';

const root = fileURLToPath(new URL('../../../',import.meta.url));
const read = name => readFileSync(join(root,name),'utf8');
const rules = await build(root);
assert.equal(rules,read(artifactPath),'generated release must be reproducible');
const cases = JSON.parse(read(nativePath+'/cases.json'));
const {results} = JSON.parse(read(nativePath+'/evidence/score-for.json'));
const runtime = pathToFileURL(join(root,'arcade/runtime/package.json')).href;
const {SimulateFirestoreRulesHandler} = await import(import.meta.resolve('@pyric/rules/internal',runtime));
const handler = new SimulateFirestoreRulesHandler();
const {paths,attempts,contribution} = fixture('native-comparison');
let checked = 0;
for (const [id,{cycle,items}] of Object.entries(cases)) {
  if (cycle !== 7) continue;
  const {points,tier,benefit} = results[id];
  const proposal = {...attempts.find(row=>row.id === 'signed-create').data,points,tier,benefit};
  const requests = [proposal,{...proposal,points:points+1}].map((data,i)=>({
    description:id,path:paths.award,method:'create',auth:{uid:'writer'},data,expectation:i ? 'DENY' : 'ALLOW'
  }));
  const result = handler.simulate(rules,requests,{getDoc:path=>path === paths.contribution ?
    {...contribution,items:items ?? {}} : null});
  assert.ok(result.success,JSON.stringify(result.error));
  assert.equal(result.data.unsupported,0);
  assert.deepEqual(result.data.results.map(row=>[row.decision,Boolean(row.resourceLimit)]),
    [['ALLOW',false],['DENY',false]],id);
  checked += requests.length;
}
console.log(checked+' generated-rule decisions matched the cycle 7 native scoring controls.');
