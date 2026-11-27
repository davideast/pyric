import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.env.ORACLE_ROOT;
const moduleURL = path=>pathToFileURL(join(root,path));
const {fixture} = await import(moduleURL('adapters/hearthfest-atomic/v1/fixture.mjs'));
const {artifactPath,build} = await import(moduleURL('adapters/hearthfest-compiled/v1/build.mjs'));
const runtime = moduleURL('arcade/runtime/package.json').href;
const {SimulateFirestoreRulesHandler,projectAfterState} =
  await import(import.meta.resolve('@pyric/rules/internal',runtime));
const handler = new SimulateFirestoreRulesHandler();
const uid = 'offline-depositor';
const {paths,initial,attempts} = fixture(uid);

function replay(rules) {
  const decisions = {};
  for (const attempt of attempts) {
    const before = new Map(Object.entries(paths).map(([role,path])=>[path,initial[role]]));
    const batchProjection = new Map();
    const requests = attempt.writes.map(({path,data})=>{
      const resource = before.get(path), writeMode = {kind:'update'};
      batchProjection.set(path,projectAfterState(writeMode,resource,data));
      return {description:attempt.id,path,method:'update',auth:{uid},resource,data,writeMode,expectation:'ALLOW'};
    });
    const result = handler.simulate(rules,requests,{getDoc:path=>before.get(path) ?? null,batchProjection});
    assert.ok(result.success,JSON.stringify(result.error));
    const rows = result.data.results;
    assert.equal(rows.length,requests.length);
    assert.equal(result.data.unsupported,0);
    assert.ok(rows.every(row=>!row.resourceLimit && ['ALLOW','DENY'].includes(row.decision)));
    decisions[attempt.id] = rows.every(row=>row.decision === 'ALLOW') ? 'ALLOW' : 'DENY';
  }
  return decisions;
}

const generated = await build(root);
const frozen = readFileSync(join(root,artifactPath),'utf8');
const lookup = 'getAfter(/databases/$(database)/documents/hearthfest/$(cycle)/contributions/$(pid))';
assert.equal(frozen.split(lookup).length,2);
const staleRead = frozen.replace(lookup,()=>lookup.replace('getAfter(','get('));
console.log(JSON.stringify({candidate:replay(generated),mutant:replay(staleRead),
  artifacts:{rulesSha256:createHash('sha256').update(generated).digest('hex')}}));
