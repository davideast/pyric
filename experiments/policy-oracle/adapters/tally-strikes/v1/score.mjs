import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {bundle,cases,compile,moves} from './fixture.mjs';
const runtime = pathToFileURL(join(process.env.ORACLE_ROOT,'arcade/runtime/package.json')).href;
const load = name=>import(import.meta.resolve('@pyric/rules/'+name,runtime));

export async function score(hosted) {
  const {compileFunction} = await load('experimental/policy');
  let program,source;
  try {
    program = compile(compileFunction);
    if (hosted) source = bundle(program);
  } catch (err) {
    const unknown = Object.fromEntries(cases.map(c=>[c.id,'UNSUPPORTED']));
    return {candidate:unknown,mutant:unknown,artifacts:{compilerError:String(err.message)}};
  }
  const handler = hosted && new (await load('internal')).SimulateFirestoreRulesHandler();
  function judge(c,actions) {
    if (!hosted) {
      const validStrikes = program.validStrikes(actions);
      assert.equal(typeof validStrikes,'boolean');
      const total = validStrikes ? Number(program.tally(89,actions)) : null;
      return {validStrikes,total,accepted:validStrikes && total === c.claim};
    }
    const resource = {owner:'writer',reader:'reader',tally:89,moves:[]};
    const simulation = handler.simulate(source,[{description:c.id,path:'tallyFolds/test',method:'update',
      expectation:'ALLOW',auth:{uid:'writer'},resource,data:{...resource,moves:actions,tally:c.claim}}]);
    assert.ok(simulation.success && !simulation.data.unsupported,JSON.stringify(simulation.error));
    const [row] = simulation.data.results;
    assert.ok(!row.resourceLimit && ['ALLOW','DENY'].includes(row.decision));
    return row.decision;
  }
  const candidate = {}, mutant = {};
  for (const c of cases) {
    const input = moves(c);
    candidate[c.id] = judge(c,input);
    // A controller which silently clamps an invalid strike loses a refusal.
    mutant[c.id] = judge(c,input.map(m=>({...m,strength:Math.min(1,m.strength)})));
  }
  return {candidate,mutant,...(hosted && {artifacts:{rulesSha256:createHash('sha256').update(source).digest('hex')}})};
}
export const standalone = ()=>score(false);
export const hosted = ()=>score(true);
