import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const at = name=>pathToFileURL(join(process.env.ORACLE_ROOT,name)).href;
const {SimulateFirestoreRulesHandler} = await import(import.meta.resolve('@pyric/rules/internal',at('arcade/runtime/package.json')));
const {rulesFor,testContext} = await import(at('adapters/ai-jrpg-campaign/v1/catalog.mjs'));
const {steps} = await import(at('adapters/conversation-queries/v1/fixture.mjs'));
const {mutate} = await import(at('adapters/ai-jrpg-campaign/v1/other.mjs'));

function run(source) {
  const handler = new SimulateFirestoreRulesHandler(), rooms = new Map(), results = {};
  const ctx = testContext('genkit');
  for (const step of steps(ctx)) {
    const subject = {description:step.id, path:step.path, auth:{uid:ctx.uids[step.actor]}, expectation:'ALLOW'};
    if (step.op === 'query') {
      subject.method = 'list';
      subject.query = {where:step.filters.map(([field,op,value])=>({field,op,value}))};
    } else {
      subject.method = step.op === 'set' ? 'create' : 'update';
      subject.resource = rooms.get(step.path);
      subject.data = step.data;
      subject.writeMode = step.op === 'set' ? {kind:'set',merge:false} : {kind:'update'};
    }
    const evaluation = handler.simulate(source,[subject],{getDoc:path=>rooms.get(path) ?? null});
    assert.ok(evaluation.success,JSON.stringify(evaluation.error));
    assert.equal(evaluation.data.unsupported,0);
    const [row] = evaluation.data.results;
    assert.ok(!row.resourceLimit && ['ALLOW','DENY'].includes(row.decision));
    let result = row.decision;
    if (result === 'ALLOW' && step.op === 'query') {
      const matches = [];
      for (const [path,room] of rooms) {
        if (step.filters.every(([,op,operand])=> {
          const requested = op === 'array-contains' ? [operand] : operand;
          return room.memberIds.some(uid=>requested.includes(uid));
        })) matches.push(step.watch.indexOf(path));
      }
      result = {verdict:'ALLOW',matches:matches.sort((a,b)=>a-b)};
    } else if (result === 'ALLOW') rooms.set(step.path,step.data);
    results[step.id] = result;
  }
  return results;
}
const source = rulesFor('genkit');
console.log(JSON.stringify({candidate:run(source),mutant:run(mutate('conversation-membership',source,'genkit'))}));
