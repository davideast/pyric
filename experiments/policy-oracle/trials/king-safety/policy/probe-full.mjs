import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha} from '../../../arcade/corpus.mjs';

const [installed] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(installed, 'package.json')));
const {compileBoundedModule, compileFunction} = await import(pathToFileURL(
  resolve(installed,pkg.exports['./experimental/policy'].import)));
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
