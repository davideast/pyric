import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureApi, root, rulesFor, testContext} from './catalog.mjs';
import {matchesFilter, materialize, raceResult} from './values.mjs';

const runtime = pathToFileURL(join(root, 'arcade/runtime/package.json')).href;
const {SimulateFirestoreRulesHandler, projectAfterState} =
  await import(import.meta.resolve('@pyric/rules/internal', runtime));
const {serverTimestamp, timestamp} = await import(import.meta.resolve('@pyric/rules', runtime));

function run(source, steps, ctx) {
  const handler = new SimulateFirestoreRulesHandler();
  let documents = new Map();
  const decisions = {};

  function request(step, docs, instant) {
    const {path, actor, op} = step;
    const resource = docs.get(path);
    const auth = actor === 'out' ? null : {uid:ctx.uids[actor], token:{email:ctx.emails[actor]}};
    const method = op === 'set' ? (docs.has(path) ? 'update' : 'create') : op === 'query' ? 'list' : op;
    const writeMode = op === 'set' ? {kind:'set', merge:false} : {kind:'update'};
    const subject = {description:step.id, method, path, auth, expectation:'ALLOW', requestTime:instant};
    if (resource !== undefined) subject.resource = resource;
    if (step.data !== undefined) {
      subject.data = materialize(step.data, serverTimestamp, timestamp);
      subject.writeMode = writeMode;
    }
    if (op === 'query') {
      // Feed constraints into the candidate's list proof before enumerating any documents.
      subject.query = {where:(step.filters ?? []).map(([field,operator,value])=>({field,op:operator,value}))};
    }
    const result = handler.simulate(source, [subject], {getDoc:key => docs.get(key) ?? null});
    assert.ok(result.success, JSON.stringify(result.error));
    assert.equal(result.data.unsupported, 0, step.id);
    const [row] = result.data.results;
    assert.ok(!row.resourceLimit && ['ALLOW','DENY'].includes(row.decision), step.id);
    if (row.decision === 'DENY') return row.decision;
    if (op === 'query') {
      const matches = [];
      for (const [key, value] of docs) {
        if (key.slice(0, key.lastIndexOf('/')) !== path) continue;
        if (!(step.filters ?? []).every(filter=>matchesFilter(value, filter))) continue;
        const index = step.watch.indexOf(key);
        assert.notEqual(index, -1, 'query result outside fixture watch: ' + key);
        matches.push(index);
      }
      return {verdict:'ALLOW', matches:matches.sort((a,b)=>a-b)};
    }
    if (op === 'delete') docs.delete(path);
    if (step.data !== undefined) {
      // Authorize the SDK transform, then store the resolved request time for later reads.
      const value = materialize(step.data, ()=>timestamp(instant), timestamp);
      docs.set(path, projectAfterState(writeMode, resource ?? null, value));
    }
    return row.decision;
  }

  for (const [index,step] of steps.entries()) {
    const millis = Date.UTC(2026,0,1) + index * 1000;
    if (step.op !== 'race') {
      decisions[step.id] = request(step, documents, new Date(millis).toISOString());
      continue;
    }
    assert.equal(step.actors.length, 2);
    function ordered(roles) {
      const docs = new Map(documents), outcomes = {};
      for (const [offset,actor] of roles.entries()) {
        const change = {...step, op:'update', actor, data:step.dataByActor[actor]};
        outcomes[actor] = request(change, docs, new Date(millis + offset).toISOString());
      }
      const summary = raceResult(outcomes, step.actors, docs.get(step.path)?.usedBy, ctx.uids);
      return {docs, summary};
    }
    const forward = ordered(step.actors), reverse = ordered([...step.actors].reverse());
    // The live claim can be won by either caller. A candidate correct in only one
    // serialization must still receive a mismatch for this case.
    decisions[step.id] = JSON.stringify(forward.summary) === JSON.stringify(reverse.summary)
      ? forward.summary : {forward:forward.summary, reverse:reverse.summary};
    documents = forward.docs;
  }
  return decisions;
}

export async function replay(family, variant) {
  const {families,mutate} = await fixtureApi(variant);
  const ctx = testContext(variant), steps = families[family](ctx), source = rulesFor(variant);
  return {candidate:run(source, steps, ctx), mutant:run(mutate(family, source, variant), steps, ctx)};
}
