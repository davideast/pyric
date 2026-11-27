import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const prior = JSON.parse(readFileSync(new URL('../../air-hockey-guest-win/v1/frames.json',import.meta.url)));
const native = prior['guest-win'];
assert.deepEqual(native.value.frame.puck,{x:48,y:96,vx:0,vy:0,t:3});
const wrongSide = structuredClone(native);
wrongSide.value.frame.puck.y = 32;
export const fixtures = {'serve-32':wrongSide,'serve-96':native};
