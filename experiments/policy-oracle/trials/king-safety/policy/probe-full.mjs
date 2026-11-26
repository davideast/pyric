import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadPolicyApi} from './public-api.mjs';
import {sha} from '../../../arcade/corpus.mjs';

const [installed] = process.argv.slice(2);
const {compileBoundedModule, compileFunction} = await loadPolicyApi(installed);
const board = readFileSync(new URL('../../chess/policies/chess.policy', import.meta.url), 'utf8');
const full = compileBoundedModule(board);
assert.ok(full.exports.includes('inCheck'));
const engine = await import('data:text/javascript;base64,' + Buffer.from(full.moduleSource).toString('base64'));
assert.equal(typeof engine.inCheck, 'function');
function attempt(source) {
  try {
    const module = compileFunction(source).firestoreModule();
    return {emitted:true, sha256:sha(module)};
  } catch (error) {
    return {emitted:false, diagnostic:String(error.message)};
  }
}
// Include the exact internal board search as a second probe; this identifies
// the next obstacle after selecting a single function from the module.
const search = board.match(/^function underAttack\([\s\S]*?^\}/m)[0];
console.log(JSON.stringify({
  sourceSha256:sha(board), standaloneTarget:full.target, inCheckExported:true,
  boundedModuleProvidesFirestoreEmitter:typeof full.firestoreModule === 'function',
  completeSourceThroughFunctionEmitter:attempt(board), individualAttackSearch:attempt(search),
},null,2));
