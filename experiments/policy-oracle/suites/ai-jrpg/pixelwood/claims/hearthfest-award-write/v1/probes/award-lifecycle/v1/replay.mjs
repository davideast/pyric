import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.env.ORACLE_ROOT;
const moduleURL = path => pathToFileURL(join(root,path));
const {fixture} = await import(moduleURL('adapters/hearthfest-award/v1/fixture.mjs'));
const {sourcePath} = await import(moduleURL('adapters/invite-profile/v1/fixture.mjs'));
const runtime = moduleURL('arcade/runtime/package.json').href;
const {SimulateFirestoreRulesHandler} = await import(import.meta.resolve('@pyric/rules/internal',runtime));
const rules = readFileSync(join(root,sourcePath),'utf8');
const handler = new SimulateFirestoreRulesHandler();

function replay(source) {
  const {attempts,paths,contribution} = fixture('offline-recipient');
  const docs = new Map([[paths.contribution,contribution]]);
  const decisions = {};
  for (const {id,actor,method,data} of attempts) {
    const resource = docs.get(paths.award);
    const request = {description:id,path:paths.award,method,auth:actor === 'signed-out' ? null : {uid:'offline-writer'},
      expectation:'ALLOW',...(resource && {resource}),...(data && {data}),
      ...(method === 'create' ? {writeMode:{kind:'set',merge:true}} : method === 'update' ? {writeMode:{kind:'update'}} : {})};
    const result = handler.simulate(source,[request],{getDoc:path=>docs.get(path) ?? null});
    assert.ok(result.success,JSON.stringify(result.error));
    const row = result.data.results[0];
    assert.ok(result.data.unsupported === 0 && !row.resourceLimit && ['ALLOW','DENY'].includes(row.decision));
    decisions[id] = row.decision;
    if (row.decision === 'ALLOW') {
      if (method === 'delete') docs.delete(paths.award);
      else docs.set(paths.award,{...resource,...data});
    }
  }
  return decisions;
}
const permission = 'allow create, update: if request.auth != null;';
assert.equal(rules.split(permission).length,2);
console.log(JSON.stringify({candidate:replay(rules),mutant:replay(rules.replace(permission,'allow create: if request.auth != null;'))}));
