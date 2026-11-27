import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

function nativeWin(adapter, key) {
  return JSON.parse(readFileSync(new URL('../../'+adapter+'/v1/frames.json',import.meta.url)))[key];
}
const wins = {
  host:nativeWin('air-hockey-winning','winning-goal'),
  guest:nativeWin('air-hockey-guest-win','guest-win'),
};

export const fixtures = {};
for (const [winner,centered] of Object.entries(wins)) {
  assert.deepEqual(centered.before.score,{host:6,guest:6});
  assert.equal(centered.value['meta/winner'],winner);
  assert.deepEqual(centered.value.frame.puck,{x:48,y:winner === 'host' ? 32 : 96,vx:0,vy:0,t:3});
  const offCenter = structuredClone(centered);
  offCenter.value.frame.puck.x = 49;
  fixtures[winner+'-x-48'] = centered;
  fixtures[winner+'-x-49'] = offCenter;
}
