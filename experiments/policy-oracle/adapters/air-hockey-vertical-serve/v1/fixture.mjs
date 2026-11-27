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
for (const [winner,stationary] of Object.entries(wins)) {
  assert.deepEqual(stationary.before.score,{host:6,guest:6});
  assert.equal(stationary.value['meta/winner'],winner);
  assert.deepEqual(stationary.value.frame.puck,{x:48,y:winner === 'host' ? 32 : 96,vx:0,vy:0,t:3});
  const moving = structuredClone(stationary);
  moving.value.frame.puck.vy = 1;
  fixtures[winner+'-vy-0'] = stationary;
  fixtures[winner+'-vy-1'] = moving;
}
