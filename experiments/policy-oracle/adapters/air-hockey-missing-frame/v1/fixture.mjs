import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const prior = JSON.parse(readFileSync(new URL('../../air-hockey-winning/v1/frames.json',import.meta.url)));
const {value, ...write} = prior['winning-goal'];
const {frame, ...terminalFields} = value;
assert.equal(frame.puck.t,3);
assert.deepEqual(terminalFields, {score:{host:7,guest:6}, 'meta/status':'over', 'meta/winner':'host'});
export const fixtures = {'missing-frame':{...write,value:terminalFields}};
