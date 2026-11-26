// Replay the database readback with two map orders and actual square differences.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const [prepared,archive]=process.argv.slice(2);
const info=JSON.parse(readFileSync(new URL('./client-board-order.json',import.meta.url)));
const raw=readFileSync(join(archive,info.receipt+'.json'));
assert.equal(createHash('sha256').update(raw).digest('hex'),info.receipt);
const obs=JSON.parse(raw).browser.observations.find(o=>o.id===info.nativeSquareOrderControl.case);
const root=resolve(prepared,'games/chess/src');
const corrected=await import(pathToFileURL(join(root,'logic.ts')));
const stock=await import(pathToFileURL(join(root,'logic-stock.ts')));
const doc=obs.snapshots[0].data;
const reverse=Object.fromEntries(Object.entries(doc.board).reverse());
const short={...reverse};delete short.a4;
const cases={
  original:{board:doc.board,expected:[true,true]},
  reversed:{board:reverse,expected:[false,true]},
  piece:{board:{...doc.board,a2:'wn'},expected:[false,false]},
  missing:{board:short,expected:[false,false]},
  extra:{board:{...doc.board,a9:''},expected:[false,false]},
};
const outcomes={};
for(const [id,{board,expected}] of Object.entries(cases)){
  const proposed={...doc,board};
  const decisions=[stock.verifyMove(proposed),corrected.verifyMove(proposed)];
  assert.deepEqual(decisions,expected,id);
  outcomes[id]={stock:decisions[0],qualifiedClient:decisions[1]};
}
console.log(JSON.stringify(outcomes,null,2));
