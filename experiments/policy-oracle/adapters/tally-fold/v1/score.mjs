import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {cases,moves,bundle,policy} from './fixture.mjs';

const runtime = pathToFileURL(join(process.env.ORACLE_ROOT,'arcade/runtime/package.json')).href;
const load = name=>import(import.meta.resolve('@pyric/rules/'+name,runtime));
function compile(compileFunction, emit) {
  try {
    const fold = compileFunction(policy);
    return emit ? bundle(fold.firestoreModule()) : fold;
  } catch (err) {
    // An older packed compiler can lack the grammar or decline this placement.
    const values = Object.fromEntries(cases.map(c=>[c.id,'UNSUPPORTED']));
    return {candidate:values,mutant:values,artifacts:{compilerError:String(err.message)}};
  }
}
export async function standalone() {
  const {compileFunction} = await load('experimental/policy');
  const fold = compile(compileFunction,false);
  if (typeof fold !== 'function') return fold;
  function judge(c,input) {
    try {
      const value = fold(90,input);
      assert.ok(typeof value === 'bigint' || Number.isSafeInteger(value),'expected a Rules int');
      assert.ok(value >= 0n && value <= 90n);
      const total = Number(value);
      return {total,accepted:c.claim === total};
    } catch (err) {
      if (!/length 3 exceeds declared bound 2/.test(err.message)) throw err;
      return {error:'bound-exceeded'};
    }
  }
  const candidate = {}, mutant = {};
  for (const c of cases) {
    candidate[c.id] = judge(c,moves(c));
    mutant[c.id] = judge(c,moves(c).reverse().slice(0,2));
  }
  return {candidate,mutant};
}
export async function hosted() {
  const {SimulateFirestoreRulesHandler} = await load('internal');
  const source = compile((await load('experimental/policy')).compileFunction,true);
  if (typeof source !== 'string') return source;
  const handler = new SimulateFirestoreRulesHandler();
  function judge(c,input) {
    const resource = {owner:'writer',reader:'reader',tally:90,moves:[]};
    const result = handler.simulate(source,[{description:c.id,path:'tallyFolds/test',method:'update',
      expectation:'ALLOW',auth:{uid:'writer'},resource,data:{...resource,moves:input,tally:c.claim}}]);
    assert.ok(result.success && !result.data.unsupported,JSON.stringify(result.error));
    const [row] = result.data.results;
    assert.ok(!row.resourceLimit && ['ALLOW','DENY'].includes(row.decision));
    return row.decision;
  }
  const candidate = {}, mutant = {};
  for (const c of cases) {
    candidate[c.id] = judge(c,moves(c));
    mutant[c.id] = judge(c,moves(c).reverse().slice(0,2));
  }
  return {candidate,mutant,artifacts:{rulesSha256:createHash('sha256').update(source).digest('hex')}};
}
