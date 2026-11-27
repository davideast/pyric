import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stock} from '../../air-hockey/v1/fixture.mjs';
import {simulate} from '../../air-hockey/v1/score.mjs';
import {fixtures} from './fixture.mjs';
import {generated} from '../../air-hockey-match-win/v1/fixture.mjs';

export async function score() {
  const runtime = pathToFileURL(join(process.env.ORACLE_ROOT,'arcade/runtime/package.json')).href;
  const {rtdbRules} = await import(import.meta.resolve('@pyric/rules',runtime));
  const {compileFunction} = await import(import.meta.resolve('@pyric/rules/experimental/policy',runtime));
  const candidate = {}, mutant = {}, artifacts = {};
  let compiled;
  try {
    compiled = generated(compileFunction);
    artifacts.rulesSha256 = createHash('sha256').update(compiled).digest('hex');
  } catch (error) {
    artifacts.compilerError = error.message;
  }
  for (const [id,fixture] of Object.entries(fixtures)) {
    candidate['stock-'+id] = simulate(rtdbRules,stock,fixture);
    mutant['stock-'+id] = candidate['stock-'+id];
    candidate['generated-'+id] = compiled ? simulate(rtdbRules,compiled,fixture) : 'UNSUPPORTED';
    // A reversed serve-side convention should disagree on both generated cases.
    const reversed = structuredClone(fixture);
    reversed.value.frame.puck.y = 128 - fixture.value.frame.puck.y;
    mutant['generated-'+id] = compiled ? simulate(rtdbRules,compiled,reversed) : 'UNSUPPORTED';
  }
  return {candidate,mutant,artifacts};
}
