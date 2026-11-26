import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction, compileBoundedModule} from '@pyric/rules/experimental/policy';

const source = readFileSync(process.argv[2], 'utf8');
let invoke;
if (source.trimStart().startsWith('use extension bounded;')) {
  const {moduleSource} = compileBoundedModule(source);
  const mod = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
  invoke = mod.pathClear;
} else {
  invoke = compileFunction(source);
}
const board = Object.fromEntries([...'abcdefgh'].flatMap(file => [...'12345678'].map(rank => [file+rank, ''])));
board.b2 = 'wr';
board.d2 = 'br';
assert.equal(invoke(board, 1, 1, 2, 0), true);
board.c2 = 'wp';
assert.equal(invoke(board, 1, 1, 2, 0), false);
console.log('Both public cases passed');
