import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stock,generated} from '../../air-hockey/v1/fixture.mjs';
import {simulate} from '../../air-hockey/v1/score.mjs';
import {fixtures} from './fixture.mjs';

export async function score() {
  const pkg = pathToFileURL(join(process.env.ORACLE_ROOT,'arcade/runtime/package.json')).href;
  const {rtdbRules} = await import(import.meta.resolve('@pyric/rules',pkg));
  const {compileFunction} = await import(import.meta.resolve('@pyric/rules/experimental/policy',pkg));
  const candidate = {}, mutant = {}, artifacts = {};
  const fixture = fixtures['missing-frame'];
  for (const profile of ['stock','generated']) {
    const key = profile+'-missing-frame';
    let rules = stock;
    if (profile === 'generated') {
      try {
        rules = generated(compileFunction);
        artifacts.rulesSha256 = createHash('sha256').update(rules).digest('hex');
      } catch (error) {
        artifacts.compilerError = error.message;
        candidate[key] = mutant[key] = 'UNSUPPORTED';
        continue;
      }
    }
    candidate[key] = simulate(rtdbRules,rules,fixture);
    // If the client dropped the metadata too, this would replay the score-only control.
    mutant[key] = simulate(rtdbRules,rules,{...fixture,value:{score:fixture.value.score}});
  }
  return {candidate,mutant,artifacts};
}
