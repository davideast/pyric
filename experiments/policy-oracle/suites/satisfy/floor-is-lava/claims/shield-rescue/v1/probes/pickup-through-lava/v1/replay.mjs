import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';

const read = name => readFileSync(new URL(name, import.meta.url));
const geometry = JSON.parse(gunzipSync(read('./geometry.json.gz')));
const omitted = read('./omitted.jsonl').toString().trimEnd().split('\n').map(row => JSON.parse(row));
assert.equal(geometry.length, omitted.length);
const runtime = join(process.env.ORACLE_ROOT, 'arcade/runtime');
const entry = Bun.resolveSync('@pyric/rules/experimental/policy', runtime);
const {compilePolicy} = await import(pathToFileURL(entry));
const source = read('./floor-heat-shield.policy').toString();

function predict(policy) {
  let shield = false, firstOmittedRefusal = null, lavaContact = null;
  const taken = new Set(), cases = {};
  for (const [index, input] of geometry.entries()) {
    const before = {shield, taken: [...taken]};
    const next = policy.derive({before, input});
    const expected = {picked: next.picked.map(Number), shield: next.shield, outcome: next.outcome,
      vx: Number(next.vx), vy: Number(next.vy)};
    const after = omitted[index];
    const verdict = policy.judge({before, input, after});
    const step = index + 1;
    cases['step-' + step] = {shieldBefore: shield, ...expected, acceptsOmitted: verdict.ok};
    if (!verdict.ok && !firstOmittedRefusal) firstOmittedRefusal = {step, expected, omitted: after, verdict};
    if (next.outcome !== 'none') lavaContact = {step, shieldBefore: shield, expected, omitted: after, verdict};
    shield = next.shield;
    if (input.restart) taken.clear();
    for (const id of expected.picked) taken.add(id);
  }
  return {cases, firstOmittedRefusal, lavaContact};
}

const candidate = predict(compilePolicy(source));
const guard = '!gem.broken &&';
assert.equal(source.split(guard).length, 2);
const mutant = predict(compilePolicy(source.replace(guard, 'gem.id != 4 && ' + guard)));
console.log(JSON.stringify({candidate: candidate.cases, mutant: mutant.cases,
  diagnostics: {firstOmittedRefusal: candidate.firstOmittedRefusal, lavaContact: candidate.lavaContact}}));
