import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.env.ORACLE_ROOT;
const {cases,seed} = await import(pathToFileURL(join(root,'adapters/ai-jrpg-clips/v1/fixture.mjs')));
const runtime = pathToFileURL(join(root,'arcade/runtime/package.json')).href;
const {parseStorageRules,evaluateStorageRules} = await import(import.meta.resolve('@pyric/rules/internal/storage',runtime));
const stock = readFileSync(new URL('storage.rules',import.meta.url),'utf8');
function score(source) {
  const rules = parseStorageRules(source), objects = new Map([[seed.path,{size:seed.size,contentType:seed.mime}]]), outcomes = {};
  for (const attempt of cases) {
    const incoming = attempt.op === 'upload' ? {size:attempt.size,contentType:attempt.mime} : undefined;
    const request = {path:'b/offline-clips/o/'+attempt.path,
      auth:attempt.actor === 'signed' ? {uid:'member'} : null,
      method:attempt.op === 'upload' ? 'write' : attempt.op === 'delete' ? 'delete' : 'get',
      ...(incoming ? {resource:incoming} : {})};
    const result = evaluateStorageRules(rules,{request,resource:objects.get(attempt.path) ?? null});
    assert.ok(!result.resourceLimit,attempt.id);
    outcomes[attempt.id] = result.allowed ? 'ALLOW' : 'DENY';
    if (result.allowed && attempt.op === 'upload') objects.set(attempt.path,incoming);
    if (result.allowed && attempt.op === 'delete') objects.delete(attempt.path);
  }
  return outcomes;
}
const bound = 'request.resource.size < 2 * 1024 * 1024';
assert.equal(stock.split(bound).length,2);
console.log(JSON.stringify({candidate:score(stock),mutant:score(stock.replace(bound,bound.replace(' < ',' <= ')))}));
