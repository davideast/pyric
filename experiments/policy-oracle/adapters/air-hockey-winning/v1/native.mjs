// Print the canonical winning write and its score-only control.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = resolve(process.argv[2]);
const revision = '66e14d4f4b0aeab22c05db8d748704dde053d2e5';
const names = ['physics.ts','logic.ts'].map(name=>'games/air-hockey/src/'+name);
execFileSync('git',['-C',root,'diff','--exit-code',revision,'--',...names]);
const [{initialWorld,step,winner,plausibleGoal},{frameOf,frameOp,livePath}] =
  await Promise.all(names.map(name=>import(pathToFileURL(resolve(root,name)))));
const previous = {...initialWorld(),score:{host:6,guest:6},puck:{x:38,y:7,vx:0,vy:-170}};
let world = previous;
for (let tick=1;tick<=3;tick++) {
  const result = step(world,world.host,world.guest);
  assert.equal(result.goal,tick === 3 ? 'host' : null);
  world = result.world;
}
assert.equal(winner(world.score),'host');
assert.equal(plausibleGoal(previous.puck,'host',world.puck,world.tick-previous.tick),true);
const op = frameOp('example','host',world,true);
assert.equal(op.path,livePath('example','host'));
assert.equal(op.type,'update');
assert.deepEqual(Object.keys(op.value).sort(),['frame','meta/status','meta/winner','score']);
const fixture = {before:{frame:frameOf(previous),score:previous.score},method:op.type,path:''};
console.log(JSON.stringify({
  'winning-goal':{...fixture,value:op.value},
  'score-only':{...fixture,value:{score:op.value.score}},
},null,2));
