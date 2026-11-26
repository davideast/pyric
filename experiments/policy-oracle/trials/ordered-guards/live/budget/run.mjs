import assert from 'node:assert/strict';
import {retain} from '../../../for-of/live/retain.mjs';
import {replay} from '../../../for-of/live/replay.mjs';
import * as fixtures from './fixtures.mjs';
const [operation,...args]=process.argv.slice(2);
const receipts=new URL('receipts/',import.meta.url);
if (operation === 'capture') {
  const {capture}=await import('../../../for-of/live/capture.mjs');
  await capture(args,fixtures);
} else if (operation === 'retain') {
  retain(args,fixtures,receipts);
} else {
  assert.equal(operation,'replay');
  const [generated,simulator,archive]=args;
  const output=await replay({generated,simulator,archive:archive==='-'?undefined:archive},fixtures,receipts);
  console.log(JSON.stringify(output,null,2));
}
