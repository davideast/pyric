// Run only when capturing the independent control. The candidate runner never opens the answers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const upstream = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const revision = '59737d2f544e213cecaebf8e9677cf95f39eaa60';
const boost = 'experiments/policy-transitions/boost';
const git = (...args) => execFileSync('git', ['-C', upstream, ...args], {encoding: 'utf8'}).trim();
const run = (...args) => JSON.parse(execFileSync(process.execPath, args, {encoding: 'utf8'}));
assert.equal(git('rev-parse', 'HEAD'), revision);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'recapture from a clean source tree');
const route = JSON.parse(git('show', revision + ':' + boost + '/fixture.json'));
const trace = run(join(upstream, boost, 'check-control.mjs'), '--print');
assert.deepEqual(trace, JSON.parse(git('show', revision + ':' + boost + '/control-trace.json')));
const captureContact = fileURLToPath(new URL('../../../../../../../../../trials/floor-boost/v1/capture-contact.mjs', import.meta.url));
const contact = run(captureContact, upstream);
assert.deepEqual(contact.before, trace.before);
assert.equal(contact.tick, route.landingStep);
assert.equal(contact.observed.support, trace.pad.id);

let direction = 0, held = false;
const steps = [], states = {};
const reference = trace.referenceRows;
assert.equal(reference.length, 13);
for (let i = 0; i < reference.length; i++) {
  const step = route.landingStep + i;
  // The pilot switches from pointer aiming to steering before this episode.
  for (const [at, action, value] of route.controls) {
    if (at >= step || (i > 0 && at < step - 1)) continue;
    if (action === 'steer') direction = value;
    if (action === 'press') held = true;
    if (action === 'release') held = false;
  }
  const {h, n} = trace.groups[i];
  assert.equal(n, 1);
  steps.push({step, h, held, direction});
  const stock = trace.stockRows[i];
  assert.deepEqual(reference[i].state, stock.state);
  const event = stock.events.map(e => e.type).join('+') || 'none';
  states['step-' + step] = {...reference[i].state, event};
}
function save(name, value) {
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
}
mkdirSync(join(output, 'evidence'), {recursive: true});
save('inputs.json', {seed: route.seed, before: {...trace.before, event: 'none'}, rails: trace.rails,
  sweep: contact.sweep, stones: contact.stones, steps});
save('evidence/typescript-replay.json', {revision, seed: route.seed, states});
