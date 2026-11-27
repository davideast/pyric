import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const prior = JSON.parse(readFileSync(new URL('../../air-hockey-winning/v1/frames.json',import.meta.url)));
const native = prior['winning-goal'];
assert.deepEqual(native.value.frame.puck,{x:48,y:32,vx:0,vy:0,t:3});
const wrongSide = structuredClone(native);
wrongSide.value.frame.puck.y = 96;
export const fixtures = {'serve-96':wrongSide,'serve-32':native};
