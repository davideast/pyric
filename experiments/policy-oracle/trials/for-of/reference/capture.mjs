import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isLegal, squareName, squareOf } from '../../chess/reference/arcade-reference.ts';

const read = path => readFileSync(new URL(path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = JSON.parse(read('./cases.json'));
const fixture = '../../../suites/satisfy/tally-slate/claims/ordered-fold/v1/probes/native-turns/v1/';
const { native } = JSON.parse(read(fixture + 'fixtures/sources.json'));
const arcade = '66e14d4f4b0aeab22c05db8d748704dde053d2e5';
const sources = {
  '../../chess/reference/arcade-reference.ts': '1f321bbb70128936c00283d22cfe03ad84b8907a00f0dacf3363b694d6534d5e',
  '../../chess/bundle/source/rayEmpty.rules': 'c6bf6ac25aa4f43eec46d8fa2b7da50b71f2d752b1700ed45ec717de10098851',
  '../../chess/bundle/source/path.rules': 'b22afc47ab63477c04ec3083a6748e32f1a5eede693cb745383b19d07f159cf7'
};
for (const [path, digest] of Object.entries(sources)) assert.equal(sha(read(path)), digest);
// Both checked, pinned helpers use the common JavaScript/Rules arithmetic subset.
// This is an offline control for complete 64-cell string maps.
const pathClear = Function(read('../../chess/bundle/source/rayEmpty.rules') + '\n' +
  read('../../chess/bundle/source/path.rules') + '\nreturn pathClear;')();
const rook = cases.rook.map(c => {
  const board = Array.from({length:64}, (_, i) => c.occupied[squareName(i)] ?? '');
  const map = Object.fromEntries(board.map((v,i) => [squareName(i),v]));
  const from = squareOf(c.from), to = squareOf(c.to);
  const position = {board,turn:'w',castling:'',enPassant:-1};
  const legal = isLegal(position, {from,to});
  const x = from % 8, y = 7 - Math.floor(from / 8);
  const clear = pathClear(map, x, y, to % 8 - x, 7 - Math.floor(to / 8) - y);
  assert.equal(legal, c.expected, c.id);
  assert.equal(clear, c.expected, c.id);
  return {id:c.id,uci:c.from+c.to,nativeLegal:legal,handwrittenPathClear:clear};
});

const directory = process.argv[2];
assert(directory, 'Pass the pinned satisfy.md source export with Zod installed');
for (const [path, digest] of Object.entries(native.files)) {
  assert.equal(sha(readFileSync(resolve(directory,path))),digest,path);
}
assert.equal(JSON.parse(readFileSync(resolve(directory,'node_modules/zod/package.json'))).version,native.parserZod);
const { createTallySlateModel } = await import(pathToFileURL(resolve(directory,native.path)).href);
const { parseTallyTurn, tallyNext } = await import(pathToFileURL(resolve(directory,native.turnParser)).href);
const tally = cases.tally.map(c => {
  const model = createTallySlateModel({value:c.start});
  const moves = Array.from({length:c.repeat ?? 1}, () => c.moves).flat();
  for (const m of moves) {
    if (m.kind === 'strike') model.strike();
    else model.erase({all:m.all});
  }
  assert.equal(model.value,c.nativeFinal,c.id);
  const parsed = parseTallyTurn({moves:moves.map((m,i) => ({
    ...m, at:i/10, ...(m.kind === 'strike' && {strength:0.65})
  }))});
  const parser = parsed.ok ? {accepted:true,value:tallyNext({value:c.start},parsed.turn.moves).value} :
    {accepted:false,issues:parsed.issues};
  if (parsed.ok) assert.equal(parser.value,c.nativeFinal,c.id);
  return {id:c.id,actions:moves.length,singleMoveModel:model.value,turnParser:parser};
});
console.log(JSON.stringify({arcade,sources,satisfy:native.revision,rook,tally},null,2));
