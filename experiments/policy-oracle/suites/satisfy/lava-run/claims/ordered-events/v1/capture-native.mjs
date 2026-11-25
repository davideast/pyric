import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [directory, probe] = process.argv.slice(2);
assert(directory && probe, 'Pass the clean satisfy.md export and probe directory');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const source = read(new URL('./sources.json', import.meta.url));
const witness = read(resolve(probe, 'cases.json'));
const archivePath = 'experiments/policy-transitions/ordered-events/';
const exportFile = (path) => join(resolve(directory), path);

for (const [path, digest] of Object.entries(source.native.files)) {
  assert.equal(createHash('sha256').update(readFileSync(exportFile(path))).digest('hex'), digest, path);
}

const modelModule = pathToFileURL(exportFile(source.native.model)).href;
const { createLavaRunModel } = await import(modelModule);
const archived = read(exportFile(archivePath + witness.tape + '.json'));
const archiveReport = read(exportFile(archivePath + 'verified.json'));
const { recording } = archiveReport.browserRuns.find(({ recording }) => recording.seed === witness.seed);
assert.equal(recording.h, 1 / 240);
assert.equal(recording.steps, witness.step);
assert.equal(recording.steps, archived.tick);
assert.equal(recording.seed, archived.seed);

let input;
let bounces = 0;
const noop = () => {};
const model = createLavaRunModel({
  seed: recording.seed,
  probe: {
    reset: noop,
    tick: noop,
    lava: noop,
    foe: noop,
    claims: noop,
    beforeEncounters(pose, spans, foes) {
      const { x, y, prevX, prevY, h, vy, held, descending, diving, landed, impact } = pose;
      input = {
        x, y, prevX, prevY, h, vy, held, descending, diving, landed, impact,
        gems: spans.flatMap(({ id, gem }) => gem ? [{ id, x: gem.x, y: gem.y, taken: gem.taken }] : []),
        foes: foes.map(({ id, x, y, vx, kind, phase }) => ({
          id, x, y, vx, hopper: kind === 'hopper', active: phase === 'active',
        })),
      };
    },
    stompBounce() {
      bounces++;
    },
  },
});

let cursor = 0;
let before;
let rawEvents;
for (let tick = 1; tick <= recording.steps; tick++) {
  while (recording.controls[cursor]?.tick === tick) {
    const { method, args } = recording.controls[cursor++];
    assert.ok(['jumpPress', 'dive'].includes(method), method);
    model[method](...args);
  }
  before = { shield: model.shielded, combo: model.stompCombo, recovery: model.recoverySeconds };
  input = undefined;
  bounces = 0;
  rawEvents = model.frame(recording.h, 1);
}
assert.equal(cursor, recording.controls.length);
assert.ok(input, 'No pre-contact geometry recorded at the target substep');

// Compare the fresh stock-model result with the earlier native tape before
// projecting out the rendering, sound, and rhythm fields.
assert.deepEqual(rawEvents, archived.events);
const nativeState = {
  y: model.y,
  vy: model.vy,
  shield: model.shielded,
  immune: model.immune,
  combo: model.stompCombo,
  phase: model.phase,
};
assert.deepEqual(nativeState, archived.after);
const eventFields = {
  'gem-pickup': ['span'],
  'foe-contact': ['foe', 'stomp', 'immune'],
  stomp: ['combo'],
  'shield-break': [],
  'lava-contact': [],
  skim: [],
  defeat: ['cause'],
};
const events = rawEvents.flatMap((event) => {
  const fields = eventFields[event.type];
  return fields ? [{ type: event.type, ...Object.fromEntries(fields.map((field) => [field, event[field]])) }] : [];
});
const { phase, ...fields } = nativeState;
const after = { ...fields, alive: phase !== 'defeat', recovery: model.recoverySeconds, bounces, events };
const alteredEvents = witness.eventIndices.map((index) => events[index]);
assert.ok(alteredEvents.every(Boolean));

console.log(JSON.stringify({
  provenance: {
    repo: source.native.repo,
    revision: source.native.revision,
    model: source.native.model,
    archivedNativeTape: archivePath + witness.tape + '.json',
    commandTape: archivePath + 'verified.json',
    runtime: 'Bun ' + Bun.version,
  },
  recording,
  rawEvents,
  nativeState,
  transition: { before, input, after },
  alteredEvents,
  results: {
    [witness.stockCase]: true,
    [witness.alteredCase]: JSON.stringify(alteredEvents) === JSON.stringify(events),
  },
}, null, 2));
