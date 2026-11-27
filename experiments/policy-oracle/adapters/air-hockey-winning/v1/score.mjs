import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stock,generated} from '../../air-hockey/v1/fixture.mjs';
import {simulate} from '../../air-hockey/v1/score.mjs';

const fixtures = JSON.parse(readFileSync(new URL('frames.json',import.meta.url)));
export async function score() {
  const pkg = pathToFileURL(join(process.env.ORACLE_ROOT,'arcade/runtime/package.json')).href;
  const {rtdbRules} = await import(import.meta.resolve('@pyric/rules',pkg));
  const {compileFunction} = await import(import.meta.resolve('@pyric/rules/experimental/policy',pkg));
  const sources = {stock}, candidate = {}, mutant = {}, artifacts = {};
  try {
    sources.generated = generated(compileFunction);
    artifacts.rulesSha256 = createHash('sha256').update(sources.generated).digest('hex');
  } catch (error) {
    artifacts.compilerError = error.message;
  }
  for (const profile of ['stock','generated']) {
    const rules = sources[profile];
    for (const [id,fixture] of Object.entries(fixtures)) {
      const key = profile+'-'+id;
      candidate[key] = rules ? simulate(rtdbRules,rules,fixture) : 'UNSUPPORTED';
      // Model a client which sends score first and loses the atomic closure.
      mutant[key] = rules ? simulate(rtdbRules,rules,{...fixture,value:{score:fixture.value.score}}) : 'UNSUPPORTED';
    }
  }
  return {candidate,mutant,artifacts};
}
