import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const {phase, steps, h, baseX, amplitude, frequency} = JSON.parse(read('./inputs.json'));
const {samples} = JSON.parse(read('./samples.json'));
assert.equal(samples.length, steps);
const source = read('./shuttle.policy');
const runtime = join(process.env.ORACLE_ROOT, 'arcade/runtime');
const {compilePolicy} = await import(pathToFileURL(Bun.resolveSync('@pyric/rules/experimental/policy', runtime)));
const input = {h, baseX, amplitude, frequency};

function score(policy) {
  let before = {phase};
  const cases = {};
  let firstDivergence = null, maxErrorPx = 0;
  for (const [index, [replayX, stockX, shiftedX]] of samples.entries()) {
    // The oscillator receives the previous derived phase and immutable course parameters.
    const next = policy.derive({before, input});
    const expectedX = Number(next.x);
    assert.ok(Number.isFinite(expectedX));
    function accepts(x) {
      const result = policy.judge({before, input, after: {x}});
      if (!result.ok && result.requirement !== 'stoneAtCoursePosition') {
        throw Error('step ' + (index + 1) + ': ' + JSON.stringify(result));
      }
      return result.ok;
    }
    const step = index + 1, error = Math.abs(expectedX - replayX);
    maxErrorPx = Math.max(maxErrorPx, error);
    const stock = accepts(stockX), shifted = accepts(shiftedX);
    cases['step-' + step] = {position: error <= 1e-12, stock, shifted};
    if (!shifted && firstDivergence === null) {
      firstDivergence = {step, expectedX, replayX, shiftedX, differencePx: shiftedX - expectedX,
        requirement: 'stoneAtCoursePosition'};
    }
    before = {phase: next.phase};
  }
  return {cases, firstDivergence, maxErrorPx};
}

const stock = score(compilePolicy(source));
// A widened position tolerance must be distinguishable from the reviewed policy.
const bound = 'after.x - derived.x <= 0.000000000001';
assert.equal(source.split(bound).length, 2);
const mutant = score(compilePolicy(source.replace(bound, 'after.x - derived.x <= 12.000000000001')));
console.log(JSON.stringify({candidate: stock.cases, mutant: mutant.cases,
  diagnostics: {firstDivergence: stock.firstDivergence, maxErrorPx: stock.maxErrorPx}}));
