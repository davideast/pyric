// Recover the swept roster and completed landing from the pinned game's public input tape.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const upstream = resolve(process.argv[2]);
const sourceCommit = '59737d2f544e213cecaebf8e9677cf95f39eaa60';
assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), sourceCommit);
const part = name => resolve(upstream, 'experiments/policy-transitions/boost', name);
const { loadControls } = await import(pathToFileURL(part('observe.mjs')));
const api = await loadControls('stock', false);
const tape = JSON.parse(readFileSync(part('fixture.json')));
let observed;
const game = api.createFloorIsLavaModel({seed:tape.seed, observeStep: state => { observed = state; }});
const hands = api.modelHands(game, tape.seed);
const control = api.floorInputReplay(tape.seed, api.LAVA_SHAFT_HEIGHT);
let geometry, before;
for (let tick = 0; tick < tape.landingStep; tick++) {
  for (const [at, command, ...args] of tape.controls) if (at === tick) {
    hands[command](...args);
    control[command](...args);
  }
  before = observed;
  game.frame(tape.stepSeconds, 1);
  control.frame(tape.stepSeconds, 1, (sweep, stones, isBroken) => {
    if (tick === tape.landingStep - 1) geometry = { sweep, stones: Array.from(stones, ({id, kind, x, y, width}) =>
      ({id, kind, x, y, width, broken: isBroken(id)})) };
  });
}
assert.ok(geometry && before && observed);
assert.equal(observed.support, tape.padId);
assert.equal(observed.remaining, 0.044);
console.log(JSON.stringify({sourceCommit, seed:tape.seed, tick:tape.landingStep,
  h:tape.stepSeconds, before, ...geometry, observed}, null, 2));
