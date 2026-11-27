import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Let the pinned physics determine the scorer and let Arcade construct the
// actual host write, including the serve to the side which conceded.
const root = resolve(process.argv[2]);
const revision = '66e14d4f4b0aeab22c05db8d748704dde053d2e5';
const paths = ['physics.ts','logic.ts'].map(file=>'games/air-hockey/src/'+file);
execFileSync('git',['-C',root,'diff','--exit-code',revision,'--',...paths]);
const [{initialWorld,step,winner,plausibleGoal,servedPuck},{frameOf,frameOp,livePath}] =
  await Promise.all(paths.map(path=>import(pathToFileURL(resolve(root,path)))));
const initial = {...initialWorld(),score:{host:6,guest:6},puck:{x:38,y:121,vx:0,vy:170}};
let world = initial;
for (let tick=1;tick<=3;tick++) {
  const result = step(world,world.host,world.guest);
  assert.equal(result.goal,tick === 3 ? 'guest' : null);
  world = result.world;
}
assert.equal(winner(world.score),'guest');
assert.deepEqual(world.puck,servedPuck('host'));
assert.equal(plausibleGoal(initial.puck,'guest',world.puck,world.tick-initial.tick),true);
const op = frameOp('example','host',world,true);
assert.equal(op.type,'update');
assert.equal(op.path,livePath('example','host'));
const {frame,...closure} = op.value;
assert.deepEqual(frame,frameOf(world));
assert.deepEqual(closure,{score:{host:6,guest:7},'meta/status':'over','meta/winner':'guest'});
const write = {before:{frame:frameOf(initial),score:initial.score},method:op.type,path:''};
console.log(JSON.stringify({
  'guest-win':{...write,value:op.value},
  'guest-win-missing-frame':{...write,value:closure},
},null,2));
