import assert from 'node:assert/strict';
import { test } from 'node:test';
import { json } from '../corpus.mjs';
import { checkBatch } from '../receipts.mjs';
import { verdict } from './score.mjs';

for (const [name,change] of [
  ['missing case', b => b.cases.pop()],
  ['duplicate in place of a missing case', b => {b.cases[0]=b.cases[1];}],
  ['changed input even if the verdict is identical', b => {b.cases[0].proposal.lastMove='c2r2';}],
  ['stale rules digest', b => {b.rules.generated=b.rules.stock;}],
  ['denied document version advanced', b => {b.cases[1].metadata.afterVersion='2027-01-01T00:00:00Z';}],
  ['cached read', b => {b.cases[0].metadata.fromCache=true;}],
  ['unchanged denied counter with a different board', b => {b.cases[1].stored.board.c2r2='host';}],
  ['error substituted for a refusal', b => {b.cases[1].code='unavailable';}],
]) {
  test(name,()=>{
    const batch=json('v1/observations/zero.json');
    change(batch);
    assert.throws(()=>checkBatch('zero',batch));
  });
}
test('an evaluator abstention cannot count as a matching refusal',()=>{
  const row=json('v1/observations/zero.json').cases[1];
  const unsupported={simulate:()=>({cases:[{decision:'DENY',unsupported:true}]})};
  assert.throws(()=>verdict(unsupported,row),/unscorable/);
});
