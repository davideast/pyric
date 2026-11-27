// Recapture independent TypeScript observations without loading Pyric.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';

const upstream = resolve(process.argv[2]), output = resolve(process.argv[3]);
const revision = '8d86ed4660d1179d4d559cc01b86505e1b014ffb';
const git = (...args) => execFileSync('git', ['-C', upstream, ...args], {encoding: 'utf8'}).trim();
assert.equal(git('rev-parse', 'HEAD'), revision);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
const seed = 20261113, omittedGem = 4, h = 1 / 240;
const fixture = join(upstream, 'experiments/policy-transitions/rescue');
const controls = JSON.parse(readFileSync(join(fixture, 'floor-controls.json')));
const milestones = JSON.parse(readFileSync(join(fixture, 'native.json'))).floor;
const pickupStep = milestones.find(row => row.events.some(e => e.type === 'shield-pickup')).step;
const contactStep = milestones.find(row => row.events.some(e => e.type === 'skim')).step;
const {build} = createRequire(join(upstream, 'package.json'))('esbuild');
async function load(omit) {
  const bundle = await build({
    stdin: {resolveDir: upstream, contents: [
      'export {createFloorIsLavaModel} from "./registry/satisfy/floor-is-lava-model";',
      'export {floorInputReplay} from "./rules/floor-input-replay";',
      'export {floorCourse} from "./rules/floor-course";',
    ].join('\n')},
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: omit ? [{name: 'omit-shield-gem', setup(builder) {
      builder.onLoad({filter: /floor-is-lava-model\.ts$/}, ({path}) => {
        const source = readFileSync(path, 'utf8');
        const guard = 'if (!plat.hasShield || plat.shieldTaken';
        assert.equal(source.split(guard).length, 2);
        return {loader: 'ts', contents: source.replace(guard, 'if (plat.id === ' + omittedGem + ' || !plat.hasShield || plat.shieldTaken')};
      });
    }}] : [],
  });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
}

const stock = await load(false);
const game = stock.createFloorIsLavaModel({seed});
const omission = (await load(true)).createFloorIsLavaModel({seed});
const replay = stock.floorInputReplay(seed), course = stock.floorCourse(seed);
function gemId(tier) {
  course.throughTier(tier);
  const gems = [...course.stones.values()].filter(s => s.hasShield && s.tier === tier);
  assert.equal(gems.length, 1);
  return gems[0].id;
}
function observe(model) {
  const events = model.frame(h, 1);
  return {picked: events.filter(e => e.type === 'shield-pickup').map(e => gemId(e.tier)),
    shield: model.shielded, outcome: events.some(e => e.type === 'skim') ? 'rescue' :
      events.some(e => e.type === 'defeat') ? 'defeat' : 'none', vx: model.vx, vy: model.vy};
}

const inputs = [], omitted = [], results = {};
let cursor = 0;
for (let step = 1; step <= contactStep; step++) {
  while (controls[cursor]?.step === step) {
    const {aim, jump} = controls[cursor++];
    game.pointAt(aim);
    omission.pointAt(aim);
    replay.aim(aim);
    if (jump) { game.jumpPress(); omission.jumpPress(); replay.press(); }
  }
  const shieldBefore = replay.state().shielded;
  const contacts = replay.frame(h, 1, undefined, geometry => inputs.push(geometry));
  assert.equal(inputs.length, step);
  const state = replay.state();
  const after = {picked: contacts.filter(c => c.startsWith('gem/')).map(c => gemId(Number(c.slice(4)))),
    shield: state.shielded, outcome: contacts.includes('lava') ? (state.phase === 'defeat' ? 'defeat' : 'rescue') : 'none',
    vx: state.vx, vy: state.vy};
  assert.deepEqual(observe(game), after, 'TypeScript replay and stock game at ' + step);
  const altered = observe(omission);
  omitted.push(altered);
  const acceptsOmitted = isDeepStrictEqual(after, altered);
  assert.equal(acceptsOmitted, step < pickupStep);
  results['step-' + step] = {shieldBefore, ...after, acceptsOmitted};
}
assert.deepEqual(results['step-' + pickupStep].picked, [omittedGem]);
assert.equal(results['step-' + contactStep].outcome, 'rescue');
assert.equal(omitted.at(-1).outcome, 'defeat');

mkdirSync(join(output, 'evidence'), {recursive: true});
writeFileSync(join(output, 'geometry.json.gz'), gzipSync(JSON.stringify(inputs) + '\n', {level: 9}));
writeFileSync(join(output, 'omitted.jsonl'), omitted.map(row => JSON.stringify(row)).join('\n') + '\n');
const rows = Object.entries(results).map(([key, value]) => '    "' + key + '": ' + JSON.stringify(value));
writeFileSync(join(output, 'evidence/replay.json'), '{\n  "revision": "' + revision + '",\n  "seed": ' + seed +
  ',\n  "results": {\n' + rows.join(',\n') + '\n  }\n}\n');
