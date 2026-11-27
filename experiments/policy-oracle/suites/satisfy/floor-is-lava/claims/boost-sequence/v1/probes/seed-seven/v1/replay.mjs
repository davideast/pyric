import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.env.ORACLE_ROOT;
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const entry = Bun.resolveSync('@pyric/rules/experimental/policy', join(root, 'arcade/runtime'));
const {compileFunction, compilePolicy} = await import(pathToFileURL(entry).href);
const pick = compileFunction(readFileSync(join(root, 'trials/floor-boost/v1/floor-pick-landing.rules'), 'utf8'));
const episode = JSON.parse(read('./inputs.json'));
const pad = episode.stones.reduce((best, stone) => pick(best, stone, episode.sweep), null);
const source = read('./boost-pad.policy');

function predict(policy) {
  let before = episode.before;
  const predictions = {};
  for (const [index, {step, ...controls}] of episode.steps.entries()) {
    const input = {...controls, ...episode.rails, contact: index === 0 && pad?.kind === 'boost',
      padId: pad?.id ?? null, padY: pad?.y ?? null};
    const after = policy.derive({before, input});
    predictions['step-' + step] = after;
    before = after;
  }
  return predictions;
}

const launch = 'launch ? 802 :';
assert.equal(source.split(launch).length, 2);
const candidate = predict(compilePolicy(source));
const mutant = predict(compilePolicy(source.replace(launch, 'launch ? 800 :')));
// Keep Pyric's numeric types throughout the fold. Project them to the replay's
// JSON numbers only when serializing predictions for the external scorer.
function serializeNumber(_, value) {
  if (typeof value === 'bigint') return Number(value);
  if (value?.__type === 'float') return value.value;
  return value;
}
console.log(JSON.stringify({candidate, mutant}, serializeNumber));
