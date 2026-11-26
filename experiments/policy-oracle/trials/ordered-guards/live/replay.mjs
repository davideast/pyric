import assert from 'node:assert/strict';
import {replay as replayCaptures} from '../../for-of/live/replay.mjs';
import * as fixtures from './fixtures.mjs';

export function replay({generated,simulator,archive,ordered}) {
  assert.ok(generated && simulator && ordered,'both full application rulesets and a reference evaluator are required');
  return replayCaptures({generated,simulator,archive,ordered},fixtures,new URL('receipts/',import.meta.url));
}

if (import.meta.main) {
  const [generated,simulator,archive,ordered] = process.argv.slice(2);
  const output = await replay({generated,simulator,archive:archive==='-'?undefined:archive,ordered});
  console.log(JSON.stringify(output,null,2));
}
