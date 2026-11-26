import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cases, initial, proposal } from './fixtures.mjs';

const [arcade,rulesRuntime] = process.argv.slice(2);
const nativeFile = 'games/chess/src/logic.ts';
for (const name of [nativeFile,'games/chess/src/chess.ts']) {
  assert.deepEqual(readFileSync(join(arcade,name)),execFileSync('git',['-C',arcade,'show','66e14d4f4b0aeab22c05db8d748704dde053d2e5:'+name]));
}
const native = await import(pathToFileURL(resolve(arcade,nativeFile)));
const {firestoreRules} = await import(pathToFileURL(resolve(rulesRuntime,'dist/index.js')));
const bundle = mode => readFileSync(new URL('../artifacts/' + mode + '.rules', import.meta.url),'utf8');
const local = {};
function check(handle,c) {
  const before = initial(native,'host-uid','guest-uid');
  const patch = proposal(native,before,c);
  const [v] = handle.simulate([{description:c.id,method:'update',path:'chess/synthetic',auth:{uid:before.host},
    resource:before,data:{...before,...patch},expectation:'ALLOW'}]).cases;
  assert.ok(!v.unsupported && !v.resourceLimit);
  return v.decision;
}
for (const mode of ['stock','compatibility','stronger']) {
  const handle = firestoreRules(bundle(mode));
  const results = cases.filter(c=>c.expected[mode]).map(c => {
    const decision = check(handle,c);
    assert.equal(decision,c.expected[mode],mode + ' ' + c.id);
    return [c.id,decision];
  });
  local[mode] = Object.fromEntries(results);
}
function mutate(source, needle, replacement) {
  assert.equal(source.split(needle).length,2);
  return source.replace(needle,replacement);
}
const shapeCall = 'pieceShape(kind, color, dx, dy, old.board[mv.to], home, ep)';
const priorCall = 'priorPosition(resource.data, request.resource.data)';
const controls = [
  ['piece-shape','stronger',shapeCall,'true',['knight-shape','bishop-shape','king-shape','rook-shape']],
  ['history','compatibility',priorCall,'true',['previous-board','previous-rights','previous-ep']],
];
const sensitivity = {};
for (const [name,mode,needle,replacement,ids] of controls) {
  const modified = firestoreRules(mutate(bundle(mode),needle,replacement));
  sensitivity[name] = ids.map(id => {
    const c = cases.find(row => row.id === id);
    const observed = check(modified,c);
    assert.equal(local[mode][id],'DENY');
    assert.equal(observed,'ALLOW',id + ' should distinguish changed ' + name);
    return {id,recorded:'DENY',mutant:observed};
  });
}
console.log(JSON.stringify({authority:'offline-rules-simulator',local,sensitivity},null,2));
