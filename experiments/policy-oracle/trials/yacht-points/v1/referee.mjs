// Evaluate emitted text with the fixed reference evaluator and the original Arcade linker.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CATEGORIES, points } from './arcade-scoring.ts';
import { rolls } from './rolls.mjs';
import { linkModule } from './link.mjs';
import { materialize } from '../../../adapters/arcade-sdk/v1/fixture.mjs';

const [root, encoded] = process.argv.slice(2);
const digest = b => createHash('sha256').update(b).digest('hex');
const refereeSource = readFileSync(new URL('arcade-scoring.ts', import.meta.url));
assert.equal(digest(refereeSource), '52ab56d3f660f9ce491e434f9f8ac0b35dabfa537d132cbe1c95c3719e116e13');
const module = Buffer.from(encoded, 'base64').toString('utf8');
const full = await linkModule(join(root, 'arcade'), module);
const { firestoreRules, timestamp } = await import(pathToFileURL(join(root, 'arcade/runtime/node_modules/@pyric/rules/dist/index.js')));
const game = firestoreRules(full);
const probe = 'suites/arcade/yacht/claims/yacht-score/v1/probes/five-equal-dice/v1';
const fixture = JSON.parse(readFileSync(join(root, probe, 'fixture.json')));
function update(sample) {
  const { actor, path, before, data, requestTime } = sample;
  return { description:sample.caseId, method:'update', writeMode:{kind:'update'}, path, auth:{uid:actor},
    resource:{...before, createdAt:timestamp(before.createdAt)}, data, requestTime, expectation:'ALLOW' };
}
function verdict(input) {
  const { cases:[row] } = game.simulate([input]);
  if (row.unsupported || row.resourceLimit || !['ALLOW','DENY'].includes(row.decision)) throw Error('Unscorable: ' + input.description);
  return row.decision;
}
const publicCases = {};
for (const { id } of fixture.cases) {
  const sample = materialize(fixture,id,{actor:'player', reader:'reader',runId:'replay'});
  publicCases[id] = verdict(update(sample));
}

// One fresh scorecard for a synthetic first turn; proposals always move the total by their claimed points.
const seed = update(materialize(fixture,'score-50',{actor:'player', reader:'reader',runId:'native'}));
const empty = Object.fromEntries(CATEGORIES.map(category => [category,-1]));
const scores = {s0:empty,s1:empty};
const template = { ...seed.resource, scores, totals:[0,0], moveCount:0 };
const answers = [], counts = { rolls:0, matches:0, wrongDecisions:0, falseAllows:0, falseDenials:0, firstDivergence:null };
function check(dice, category, proposed, expected) {
  const data = {...seed.data, scores:{s0:{...empty,[category]:proposed},s1:empty}, totals:[proposed,0], lastCategory:category, moveCount:1};
  const actual = verdict({...seed,resource:{...template,dice},data});
  if (actual === expected) counts.matches++;
  else {
    counts.wrongDecisions++;
    if (actual === 'ALLOW') counts.falseAllows++;
    else counts.falseDenials++;
    counts.firstDivergence ??= {dice,category,proposed,expected,actual};
  }
}
for (const dice of rolls()) {
  counts.rolls++;
  for (const category of CATEGORIES) {
    const correct = points(category,dice);
    answers.push(correct);
    check(dice,category,correct,'ALLOW');
    check(dice,category,correct + 1,'DENY');
  }
}
console.log(JSON.stringify({categories:CATEGORIES, answers:Buffer.from(answers).toString('base64'), publicCases, completeUpdates:counts,
  bundleSha256:digest(full), bundle:Buffer.from(full).toString('base64')}));
