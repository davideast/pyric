// Run with Bun against the pinned Arcade checkout. stdout is the full input fixture.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = resolve(process.argv[2]);
const revision = '66e14d4f4b0aeab22c05db8d748704dde053d2e5';
for (const path of ['physics.ts','logic.ts']) {
  const name = 'games/air-hockey/src/' + path;
  execFileSync('git',['-C',root,'diff','--exit-code',revision,'--',name]);
}
const load = name => import(pathToFileURL(resolve(root,'games/air-hockey/src',name)));
const {initialWorld,step,plausibleGoal,plausibleMove} = await load('physics.ts');
const {frameOf,frameOp} = await load('logic.ts');
const rows = {};
function record(id, previous, next, goal) {
  const before = {frame:frameOf(previous),score:previous.score};
  const op = frameOp('example','host',next,!!goal);
  const frame = frameOf(next), ticks = frame.puck.t - before.frame.puck.t;
  const ordinary = plausibleMove(before.frame.puck,frame.puck,ticks);
  if (goal) {
    assert.equal(ordinary,false);
    assert.equal(plausibleGoal(before.frame.puck,goal,frame.puck,ticks),true);
  } else assert.equal(ordinary,id === 'move-22');
  rows[id] = {before,method:op.type,path:op.path.slice('airhockey/example/host'.length),value:op.value};
}
const w = initialWorld();
w.puck.x = 40;
for (const d of [22,23]) record('move-'+d,w,{...w,tick:3,puck:{...w.puck,x:40+d}});
const previous = {...initialWorld(),puck:{x:38,y:7,vx:0,vy:-170}};
let next = previous, goal;
for (let i=0;i<3;i++) {
  const result = step(next,next.host,next.guest);
  next = result.world;
  goal = result.goal;
}
assert.equal(goal,'host');
record('goal-reset',previous,next,goal);
console.log(JSON.stringify(rows,null,2));
