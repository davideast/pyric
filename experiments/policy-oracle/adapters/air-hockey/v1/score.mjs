import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtures,generated,seed,stock} from './fixture.mjs';

export function simulate(rtdbRules, source, fixture) {
  const {path,method,value} = fixture;
  const result = rtdbRules(source).simulate([{operation:method === 'update' ? 'update' : 'write',
    path:'/airhockey/example/host'+path, auth:'host', expectation:'ALLOW',
    data:{airhockey:{example:{host:seed(fixture,'guest')}}},newData:value}]);
  return result.cases[0].decision;
}

export async function score() {
  const pkg = pathToFileURL(join(process.env.ORACLE_ROOT,'arcade/runtime/package.json')).href;
  const {rtdbRules} = await import(import.meta.resolve('@pyric/rules',pkg));
  const {compileFunction} = await import(import.meta.resolve('@pyric/rules/experimental/policy',pkg));
  const candidate = {}, mutant = {}, artifacts = {};
  let compiled;
  try {
    compiled = generated(compileFunction);
    artifacts.rulesSha256 = createHash('sha256').update(compiled).digest('hex');
  } catch (e) { artifacts.compilerError = e.message; }
  for (const [id,fixture] of Object.entries(fixtures)) {
    const original = simulate(rtdbRules,stock,fixture);
    const projected = compiled ? simulate(rtdbRules,compiled,fixture) : 'UNSUPPORTED';
    candidate['stock-'+id] = original;
    candidate['generated-'+id] = projected;
    mutant['stock-'+id] = projected;
    mutant['generated-'+id] = original;
  }
  return {candidate,mutant,artifacts};
}
