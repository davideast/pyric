// No credentials or hosted calls. HTTP covers only the early signed-out branch. The
// other expectations use the pinned public policy entry points and local rules evaluator.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundaryCases,boundarySeed,lifecycleOperations,stamp } from './admission-fixtures.mjs';

const [integrated,nativeFile,simulator] = process.argv.slice(2);
const load = file => import(pathToFileURL(resolve(file)));
const native = await load(nativeFile), boardPolicy = await load(join(integrated,'policies/chess.mjs'));
const matchPolicy = await load(join(integrated,'policies/chess-match.mjs'));
const {fromPolicy,move} = await load(join(integrated,'live/snapshots.mjs'));
const {refereeServer} = await load(join(integrated,'live/referee.mjs'));
const {SimulateFirestoreRulesHandler} = await load(join(simulator,'dist/simulator/handler.js'));
const {checkRulesSource} = await load(join(simulator,'dist/grammar/source-compile-limits.js'));
const rules = readFileSync(join(integrated,'bundle/artifacts/referee.rules'),'utf8');
const {ast,ok} = checkRulesSource(rules);
assert.ok(ok);
const handler = new SimulateFirestoreRulesHandler(), identities = {host:'host',guest:'guest',reader:'observer'};
const target = JSON.parse(readFileSync(join(integrated,'../../arcade/v1/manifest.json'))).target;
const observations = {};
for (const c of boundaryCases) {
  const seed = boundarySeed(c,native,identities);
  if (c.role===null) {
    const fail = () => assert.fail('signed-out request reached a storage or logging dependency');
    const srv = await refereeServer({config:{projectId:target.project},gameBuild:'.',engine:boardPolicy,
      matchPolicy,verify:fail,journal:{event:fail},allowed:new Set()});
    try {
      const r = await fetch(srv.origin+'/move',{method:'POST',headers:{origin:srv.origin,'content-type':'application/json'},
        body:JSON.stringify({id:'match',ply:c.ply,uci:c.uci})});
      assert.equal(r.status,c.status); assert.deepEqual(await r.json(),{requirement:c.requirement});
      assert.deepEqual(srv.records,[]);
      observations[c.id] = {authority:'local-http',status:r.status,verdict:c.requirement};
    } finally { await srv.close(); }
  } else if (c.uci) {
    let verdict = matchPolicy.admit(seed,identities[c.role],c.ply);
    if (verdict === 'ok') {
      const patch = fromPolicy(boardPolicy,matchPolicy,seed,c.uci);
      if (patch) assert.deepEqual(patch,native.moveUpdate(seed,move(c.uci)),c.id);
      verdict = patch?'committed':'legalMove';
    }
    assert.equal(verdict,c.requirement,c.id);
    observations[c.id] = {authority:'standalone-policy',verdict};
  } else {
    const id='example', parent='chess/'+id, before=new Map([[parent,seed]]);
    const ops=lifecycleOperations(c,id,native,identities);
    const projection=new Map(ops.map(op=>{
      const data={...(op.op==='update' ? seed : {}),...op.data};
      for(const f of op.serverTimestamp??[]) data[f]={__type:'serverTimestamp'};
      if(!before.has(op.path)) before.set(op.path,null);
      return [op.path,data];
    }));
    const getDoc=path=>{ assert.ok(before.has(path),path); return before.get(path); };
    const results=ops.map(op=>{
      const previous=before.get(op.path);
      const r=handler.simulateParsed(ast,rules,[{description:c.id,path:op.path,auth:{uid:identities[c.role]},
        expectation:'DENY',requestTime:stamp,method:previous?'update':'create',...(previous && {resource:previous}),data:projection.get(op.path)}],
      {getDoc,batchProjection:projection});
      assert.ok(r.success);
      const result=r.data.results[0];
      assert.ok(result.state!=='UNSUPPORTED' && !result.resourceLimit);
      return result.decision;
    });
    assert.ok(results.includes('DENY'));
    observations[c.id]={authority:'local-rules',operations:results,verdict:'DENY'};
  }
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({fixtures:sha(readFileSync(new URL('admission-fixtures.mjs',import.meta.url))),
  refereeRules:sha(rules),board:sha(readFileSync(join(integrated,'policies/chess.mjs'))),
  match:sha(readFileSync(join(integrated,'policies/chess-match.mjs'))),observations},null,2));
