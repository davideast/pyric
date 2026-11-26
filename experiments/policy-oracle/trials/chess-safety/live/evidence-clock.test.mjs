import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {now,withMonotonicEvidenceClock} from '../../../arcade/live/controller/archive.mjs';

test('proof order survives a wall-clock correction only inside the opted-in capture', async t=>{
  let wall=Date.parse('2026-11-26T15:00:00Z');
  t.mock.method(Date,'now',()=>wall);
  await withMonotonicEvidenceClock(async()=>{
    const start=Date.parse(now());
    wall-=17000;
    await wait(8);
    assert.ok(Date.parse(now())>start);
  });
  assert.equal(Date.parse(now()),wall);
});
