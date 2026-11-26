import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {position} from '../../chess/reference/score.mjs';
import {legalMoves} from '../../chess/reference/native.mjs';
import {squareName, squareOf} from '../../chess/reference/arcade-reference.ts';

const read = path => readFileSync(new URL(path, import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
const sources = {
  '../../chess/reference/arcade-reference.ts':'1f321bbb70128936c00283d22cfe03ad84b8907a00f0dacf3363b694d6534d5e',
  '../../chess/bundle/source/rayEmpty.rules':'c6bf6ac25aa4f43eec46d8fa2b7da50b71f2d752b1700ed45ec717de10098851',
  '../../chess/bundle/source/path.rules':'b22afc47ab63477c04ec3083a6748e32f1a5eede693cb745383b19d07f159cf7'
};
for (const [path, hash] of Object.entries(sources)) assert.equal(sha(read(path)), hash);
const pathClear = Function(read('../../chess/bundle/source/rayEmpty.rules') + '\n' +
  read('../../chess/bundle/source/path.rules') + '\nreturn pathClear;')();
export function argumentsFor(c) {
  const {board} = position(c.fen);
  const map = Object.fromEntries(board.map((value,index) => [squareName(index), value]));
  const from = squareOf(c.uci.slice(0,2)), to = squareOf(c.uci.slice(2));
  const x = from % 8, y = 7 - Math.floor(from / 8);
  return [map, x, y, to % 8 - x, 7 - Math.floor(to / 8) - y];
}
if (import.meta.main) {
  const {rook} = JSON.parse(read('./cases.json'));
  const results = rook.map(c => {
    const nativeLegal = legalMoves(position(c.fen)).includes(c.uci);
    const handwrittenPathClear = pathClear(...argumentsFor(c));
    assert.equal(nativeLegal, c.expected === 'ALLOW', c.id);
    assert.equal(handwrittenPathClear, nativeLegal, c.id);
    return {id:c.id, nativeLegal, handwrittenPathClear};
  });
  console.log(JSON.stringify({arcade:'66e14d4f4b0aeab22c05db8d748704dde053d2e5', sources, results},null,2));
}
