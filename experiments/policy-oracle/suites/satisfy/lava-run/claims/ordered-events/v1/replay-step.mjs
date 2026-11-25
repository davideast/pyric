import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const read = (url) => readFileSync(url, 'utf8');

export async function replay(probe) {
  const runtime = join(process.env.ORACLE_ROOT, 'arcade/runtime');
  const entry = Bun.resolveSync('@pyric/rules/experimental/policy', runtime);
  const { compilePolicy } = await import(pathToFileURL(entry).href);
  const source = read(new URL('./runner-ordered-events.policy', import.meta.url));
  const { stockCase, alteredCase, eventIndices, replace } = JSON.parse(read(new URL('./cases.json', probe)));
  const transition = JSON.parse(read(new URL('./transition.json', probe)));
  const altered = { ...transition.after, events: eventIndices.map((index) => transition.after.events[index]) };
  assert.ok(altered.events.every(Boolean));
  assert.equal(source.split(replace.from).length, 2, 'mutation must match exactly one expression');

  function verdicts({ judge }) {
    const stockVerdict = judge(transition);
    const alteredVerdict = judge({ ...transition, after: altered });
    for (const verdict of [stockVerdict, alteredVerdict]) {
      if (!verdict.ok) assert.equal(verdict.requirement, 'stompSequence');
    }
    return { [stockCase]: stockVerdict.ok, [alteredCase]: alteredVerdict.ok };
  }

  return {
    candidate: verdicts(compilePolicy(source)),
    mutant: verdicts(compilePolicy(source.replace(replace.from, replace.to))),
  };
}
