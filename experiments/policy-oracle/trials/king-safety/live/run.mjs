import assert from 'node:assert/strict';
import {retain} from '../../for-of/live/retain.mjs';
import {replay} from '../../for-of/live/replay.mjs';
import * as primary from './fixtures.mjs';

const argv = process.argv.slice(2);
const cohort = ['cost','optimized'].includes(argv[0]) ? argv.shift() : undefined;
const [operation,...args] = argv;
const fixtures = cohort ? await import('./'+cohort+'/fixtures.mjs') : primary;
const receipts = new URL(cohort?cohort+'/receipts/':'receipts/',import.meta.url);
if (operation === 'capture') {
  const {capture} = await import('../../for-of/live/capture.mjs');
  await capture(args,fixtures);
} else if (operation === 'retain') {
  retain(args,fixtures,receipts);
} else {
  assert.equal(operation,'replay');
  const [generated,simulator,archive] = args;
  assert.ok(generated && simulator,'supply the exact generated file and the pinned reference evaluator');
  const score=await replay({generated,simulator,archive:archive==='-'?undefined:archive},fixtures,receipts);
  if(cohort==='optimized') score.paired=fixtures.compareControlInputs();
  console.log(JSON.stringify(score,null,2));
}
