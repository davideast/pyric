import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join, resolve} from 'node:path';

const upstream = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const revision = '59737d2f544e213cecaebf8e9677cf95f39eaa60';
const git = (...args) => execFileSync('git', ['-C', upstream, ...args], {encoding: 'utf8'}).trim();
assert.equal(git('rev-parse', 'HEAD'), revision);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
const {build} = createRequire(join(upstream, 'package.json'))('esbuild');
const seed = 1901463376, id = 2, offset = 12, h = 1 / 240;

function insert(source, anchor, replacement) {
  assert.equal(source.split(anchor).length, 2, 'expected one instrumentation site: ' + anchor);
  return source.replace(anchor, () => replacement);
}

async function fly(shiftAfter) {
  const bundle = await build({
    stdin: {resolveDir: upstream, contents: [
      'export {floorCourse} from "./rules/floor-course";',
      'export {routeModel, modelHands, flyTurn} from "./playground/src/demos/floor-is-lava/pilot";',
    ].join('\n')},
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{name: 'shuttle-observer', setup(builder) {
      builder.onLoad({filter: /floor-is-lava-model\.ts$/}, ({path}) => {
        let source = readFileSync(path, 'utf8');
        const start = 'const prevPlatX = plat.x;';
        if (shiftAfter !== undefined) {
          // Same one-time base, body and rail translation as shifted-platform.mjs.
          source = insert(source, start, `if (plat.id === ${id} && worldTime > ${shiftAfter} && !plat.fixtureShifted) {
            plat.fixtureShifted = true;
            plat.baseX += ${offset}; plat.x += ${offset};
            plat.railMinX += ${offset}; plat.railMaxX += ${offset};
          } ` + start);
        }
        const dx = 'const dx = hitX - plat.x;';
        source = insert(source, dx, dx + ' options.probe?.detector(plat.id, plat.x, hitX, dx, forgiveHalf);');
        return {contents: source, loader: 'ts'};
      });
    }}],
  });
  const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
  const positions = [], detections = [];
  const model = api.routeModel(seed, {
    reset() {}, flight() {}, landed() {}, pickup() {},
    course(duration, viewport, camera, lava, support, stones) {
      assert.equal(duration, h);
      positions.push(stones.find(stone => stone.id === id).x);
    },
    detector(stone, centerX, crossingX, dx, radius) {
      if (stone === id) detections.push({step: positions.length, centerX, crossingX, dx, radius});
    },
  });
  const hands = api.modelHands(model, seed);
  const hop = stone => api.flyTurn(model, [{kind: 'hop', at: 0, stone}], hands);
  const prefix = hop(1);
  assert.ok(prefix.ok);
  assert.equal(prefix.end.stone, 1);
  const prefixEnd = model.worldTime;
  assert.equal(positions.length, 156);
  const turn = hop(id);
  assert.ok(turn.ok);
  assert.equal(turn.end.stone, id);
  const accepted = detections.filter(d => Math.abs(d.dx) <= d.radius);
  assert.equal(accepted.length, 1);
  const landing = accepted[0];
  assert.equal(positions[landing.step - 1], landing.centerX);
  return {positions, landing, prefixEnd, floorCourse: api.floorCourse};
}

const stock = await fly();
const shifted = await fly(stock.prefixEnd);
const course = stock.floorCourse(seed);
course.throughTier(id);
const shuttle = course.stones.get(id);
assert.equal(shuttle.kind, 'shuttle');
const inputs = {seed, id, h, phase: shuttle.phase, frequency: shuttle.frequency,
  amplitude: shuttle.amplitude, baseX: shuttle.baseX, steps: stock.positions.length};
assert.equal(shifted.positions.length, inputs.steps);
assert.equal(stock.landing.step, shifted.landing.step);
assert.equal(shifted.landing.centerX - stock.landing.centerX, offset);
const samples = [], verdicts = {};
for (let i = 0; i < inputs.steps; i++) {
  course.advance(h);
  const reference = shuttle.x, platform = stock.positions[i], moved = shifted.positions[i];
  assert.equal(reference, platform);
  const isStock = moved === reference;
  assert.equal(isStock, i < 156);
  if (!isStock) assert.ok(Math.abs(moved - reference - offset) < 1e-12);
  samples.push([reference, platform, moved]);
  verdicts['step-' + (i + 1)] = {position: true, stock: true, shifted: isStock};
}

mkdirSync(join(output, 'evidence'), {recursive: true});
function write(path, bytes) {
  writeFileSync(join(output, path), bytes + '\n');
}
write('inputs.json', JSON.stringify(inputs, null, 2));
const columns = ['replayX', 'stockX', 'shiftedX'];
const rows = samples.map(row => '    ' + JSON.stringify(row)).join(',\n');
const sampleFile = '{\n  "columns": ' + JSON.stringify(columns) + ',\n  "samples": [\n' + rows + '\n  ]\n}';
write('samples.json', sampleFile);
const metadata = {revision, seed, id, offset, stockLanding: stock.landing, shiftedLanding: shifted.landing,
  samplesSha256: createHash('sha256').update(sampleFile + '\n').digest('hex')};
const answers = Object.entries(verdicts).map(([key, value]) =>
  '    ' + JSON.stringify(key) + ': ' + JSON.stringify(value)).join(',\n');
write('evidence/native.json', JSON.stringify(metadata, null, 2).slice(0, -2) +
  ',\n  "verdicts": {\n' + answers + '\n  }\n}');
