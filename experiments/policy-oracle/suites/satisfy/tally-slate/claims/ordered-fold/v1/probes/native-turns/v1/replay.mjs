import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtime = process.env.ORACLE_ROOT
  ? pathToFileURL(join(process.env.ORACLE_ROOT, 'arcade/runtime/'))
  : new URL('../../../../../../../../../arcade/runtime/', import.meta.url);
const entryPoint = Bun.resolveSync('@pyric/rules/experimental/policy', fileURLToPath(runtime));
const { compilePolicy } = await import(pathToFileURL(entryPoint).href);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const turns = JSON.parse(read('./fixtures/turns.json'));
const { policy } = JSON.parse(read('./fixtures/sources.json'));
const judge = compilePolicy(read('./fixtures/strike-turn.policy'), {
  expressionLimit: policy.expressionLimit,
}).judge;
const fixed = { component: 'tally-slate' };

function judgeTally(start, moves, proposed) {
  return judge({
    before: { head: 0, tally: start, fixed },
    after: { head: 1, tally: proposed, fixed },
    input: { length: moves.length, moves },
  });
}

// The mutant reduces a turn to a bag of moves. A reset dominates the bag,
// and ordinary strikes and erases are summed before applying the bounds.
function unorderedTally(start, moves) {
  if (moves.some((move) => move.kind === 'erase' && move.all)) return 0;
  const delta = moves.reduce((sum, move) => sum + (move.kind === 'strike' ? 1 : -1), 0);
  return Math.max(0, Math.min(90, start + delta));
}

const candidate = {};
const mutant = {};
const boundary = {};
for (const [id, turn] of Object.entries(turns)) {
  const moves = Array.from({ length: turn.repeat ?? 1 }, () => turn.moves).flat();
  if ('policyOnlyProposal' in turn) {
    const verdict = judgeTally(turn.start, moves, turn.policyOnlyProposal);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.requirement, 'tallyMatches');
    assert.match(verdict.reason, /Collection exceeds declared limit 400/);
    boundary[id] = verdict;
    continue;
  }
  for (const [caseId, proposed] of Object.entries(turn.proposals)) {
    const verdict = judgeTally(turn.start, moves, proposed);
    if (!verdict.ok) {
      assert.equal(verdict.requirement, 'tallyMatches');
      assert.match(verdict.reason, /^after\.tally was \d+, expected \d+$/);
    }
    if (moves.length === 400 && verdict.ok) boundary[id] = verdict;
    candidate[caseId] = verdict.ok;
    mutant[caseId] = proposed === unorderedTally(turn.start, moves);
  }
}

console.log(JSON.stringify(process.argv.includes('--policy-boundary') ? boundary : { candidate, mutant }));
