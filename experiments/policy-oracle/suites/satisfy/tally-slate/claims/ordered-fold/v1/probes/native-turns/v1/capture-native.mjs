import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [directory, mode] = process.argv.slice(2);
assert(directory, 'Pass the directory of the clean satisfy.md export');
assert(mode === undefined || mode === '--parser', 'Use --parser for the separate stock agent-turn check');
const source = resolve(directory);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const { native } = JSON.parse(read('./fixtures/sources.json'));
const turns = JSON.parse(read('./fixtures/turns.json'));

for (const [path, digest] of Object.entries(native.files)) {
  const bytes = readFileSync(join(source, path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, path);
}

const results = {};
const transcripts = {};
if (mode === '--parser') {
  const { parseTallyTurn, tallyNext } = await import(pathToFileURL(join(source, native.turnParser)).href);
  for (const [id, turn] of Object.entries(turns)) {
    const moves = Array.from({ length: turn.repeat ?? 1 }, () => turn.moves).flat().map((move, index) => ({
      ...move,
      at: index / 10,
      ...(move.kind === 'strike' ? { strength: 0.65 } : {}),
    }));
    const parsed = parseTallyTurn({ moves });
    if (parsed.ok) {
      const tally = tallyNext({ value: turn.start }, parsed.turn.moves).value;
      transcripts[id] = { accepted: true, moveCount: parsed.turn.moves.length, tally };
      for (const [caseId, proposed] of Object.entries(turn.proposals ?? {})) {
        results[caseId] = proposed === tally;
      }
    } else {
      transcripts[id] = { accepted: false, issues: parsed.issues };
      assert.equal(moves.length, 401);
    }
  }
} else {
  const { createTallySlateModel } = await import(pathToFileURL(join(source, native.path)).href);
  for (const [id, turn] of Object.entries(turns)) {
    const model = createTallySlateModel({ value: turn.start });
    const moves = Array.from({ length: turn.repeat ?? 1 }, () => turn.moves).flat();
    const steps = moves.map((move) => {
      const events = move.kind === 'strike' ? model.strike() : model.erase({ all: move.all });
      return { tally: model.value, events };
    });
    const short = steps.length <= 2;
    const checkpoints = short ? steps : steps.flatMap((step, index) => {
      const moveNumber = index + 1;
      return [1, 89, 90, 91, steps.length].includes(moveNumber) ? [{ moveNumber, ...step }] : [];
    });
    transcripts[id] = {
      initialTally: turn.start,
      cap: model.max,
      moveCount: steps.length,
      finalTally: model.value,
      checkpoints,
      ...(turn.proposals ? { proposals: turn.proposals } : {}),
    };
    for (const [caseId, proposed] of Object.entries(turn.proposals ?? {})) {
      results[caseId] = proposed === model.value;
    }
  }
}

console.log(JSON.stringify({
  provenance: {
    repo: native.repo,
    revision: native.revision,
    entryPoint: mode === '--parser' ? native.turnParser : native.path,
    runtime: 'Bun ' + Bun.version,
    ...(mode === '--parser' ? { dependencies: { zod: native.parserZod } } : {}),
  },
  transcripts,
  results,
}, null, 2));
