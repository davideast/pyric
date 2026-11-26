import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = resolve(process.argv[2]);
const stock = await import(pathToFileURL(resolve(base,'native.mjs')));
const client = await import(pathToFileURL(resolve(base,'games/chess/src/logic.ts')));
const before = {...stock.initialFields(),host:'host',guest:'guest',status:'playing',winner:'',moveCount:0,currentTurn:'host'};
const doc = {...before,...stock.moveUpdate(before,{from:53,to:45})}; // f2-f3
assert.equal(stock.verifyMove(doc),true);
const reordered = {...doc,board:Object.fromEntries(Object.entries(doc.board).reverse())};
assert.equal(stock.verifyMove(reordered),false);
assert.equal(client.verifyMove(reordered),true);
for (const board of [{...reordered.board,f3:''},{...reordered.board,i9:''},
  Object.fromEntries(Object.entries(reordered.board).filter(([sq]) => sq !== 'f2'))]) {
  assert.equal(client.verifyMove({...reordered,board}),false);
}
console.log('Native order-sensitive replay reproduced. Client accepts reordered identical squares and rejects changed, extra and missing squares.');
