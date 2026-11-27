import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileFunction} from '../../../../packages/rules/dist/policy/index.js';
import {rtdbRules} from '../../../../packages/rules/dist/index.js';

const root = resolve(process.argv[2]);
const load = file=>import(pathToFileURL(resolve(root,'games/air-hockey/src',file)));
const {plausibleMove,plausibleGoal,servedPuck,initialWorld,step,winner} = await load('physics.ts');
const {frameOf} = await load('logic.ts');
const {autopilot} = await load('autopilot.ts');
const check = compileFunction(readFileSync(new URL('plausible-move.policy',import.meta.url),'utf8'));
const checkGoal = compileFunction(readFileSync(new URL('plausible-goal.policy',import.meta.url),'utf8'));
const stock = rtdbRules(readFileSync(resolve(root,'app/database.rules.json'),'utf8'));
const frame = frameOf(initialWorld());
frame.puck.x = 40;
const data = {airhockey:{m:{h:{meta:{guest:'g',status:'playing',winner:''},frame,score:{host:0,guest:0}}}}};
for (const x of [62,63]) {
  const next = {...frame,puck:{...frame.puck,x,t:3}};
  const native = plausibleMove(frame.puck,next.puck,3);
  const pyric = check(frame.puck,next.puck,3);
  const [row] = stock.simulate([{description:'three-tick displacement',operation:'write',expectation:'ALLOW',
    path:'/airhockey/m/h/frame',auth:'h',data,newData:next}]).cases;
  assert.equal(pyric,native);
  assert.equal(native,x === 62);
  assert.equal(row.decision,'ALLOW');
  console.log({displacement:x-40,native,standalone:pyric,localStockRTDB:row.decision});
}

const serve = servedPuck('guest');
for (const [last,puck,expected] of [
  [{x:48,y:2},serve,true],
  [{x:48,y:64},serve,false],
  [{x:48,y:2},{...serve,x:47},false],
]) {
  assert.equal(plausibleGoal(last,'host',puck,3),expected);
  assert.equal(checkGoal(last,'host',puck,3),expected);
}

for (const seed of [3,36]) {
  let state = seed, world = initialWorld(), last = frameOf(world), checked = 0, goals = 0;
  const random = ()=>((state = state * 16807 % 2147483647) / 2147483647);
  const plan = ()=>({aim:random()*2-1,guard:random()<0.5 ? 8 : 88});
  let host,guest;
  while (!winner(world.score) && world.tick < 36000) {
    if (world.tick % 60 === 0) { host = plan(); guest = plan(); }
    const result = step(world,autopilot('host',world,host),autopilot('guest',world,guest));
    world = result.world;
    if (world.tick % 3 !== 0 && !result.goal) continue;
    const current = frameOf(world);
    const ticks = current.puck.t-last.puck.t;
    if (result.goal) {
      const native = plausibleGoal(last.puck,result.goal,current.puck,ticks);
      assert.equal(native,true);
      assert.equal(checkGoal(last.puck,result.goal,current.puck,ticks),native);
      goals++;
    } else {
      const native = plausibleMove(last.puck,current.puck,ticks);
      assert.equal(native,true);
      assert.equal(check(last.puck,current.puck,ticks),native);
      checked++;
    }
    last = current;
  }
  assert.ok(winner(world.score));
  console.log({seed,ordinaryTransitions:checked,goals,final:world.score});
}
