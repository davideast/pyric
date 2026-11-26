import assert from 'node:assert/strict';
import {retain} from '../../for-of/live/retain.mjs';
import {replay} from '../../for-of/live/replay.mjs';
import * as primary from './fixtures.mjs';

const argv = process.argv.slice(2);
const cost = argv[0] === 'cost';
if (cost) argv.shift();
const [operation,...args] = argv;
const fixtures = cost ? await import('./cost/fixtures.mjs') : primary;
const receipts = new URL(cost?'cost/receipts/':'receipts/',import.meta.url);
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
  console.log(JSON.stringify(score,null,2));
}
