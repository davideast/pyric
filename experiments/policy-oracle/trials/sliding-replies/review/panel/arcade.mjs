import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {position} from '../../../chess/reference/score.mjs';
import {inCheck,isLegal,squareOf} from '../../../chess/reference/arcade-reference.ts';
import {apply,legalMoves,outcome} from '../../../chess/reference/native.mjs';

const bytes=gunzipSync(readFileSync(new URL('./boards.json.gz',import.meta.url)));
const meta=JSON.parse(readFileSync(new URL('./freeze.json',import.meta.url)));
assert.equal(createHash('sha256').update(bytes).digest('hex'),meta.inputsAndRepliesSha256);
const rows=JSON.parse(bytes);
let moves=0,sliders=0;
for(const row of rows) {
  const before=position(row.fen);
  const move={from:squareOf(row.uci.slice(0,2)),to:squareOf(row.uci.slice(2,4))};
  assert.ok(isLegal(before,move),row.id);
  const after=apply(before,row.uci);
  assert.deepEqual(after,position(row.successor),row.id);
  assert.ok(inCheck(after),row.id);
  const replies=legalMoves(after).sort();
  assert.deepEqual(replies,row.replies,row.id);
  assert.deepEqual(replies.filter(m=>['b','r','q'].includes(after.board[squareOf(m.slice(0,2))][1])),row.sliderReplies,row.id);
  assert.equal(outcome(after),replies.length?'playing':'checkmate',row.id);
  moves+=replies.length;sliders+=row.sliderReplies.length;
}
assert.equal(rows.length,meta.boards);
console.log(JSON.stringify({authority:'pinned Arcade native chess reference',inputsAndRepliesSha256:meta.inputsAndRepliesSha256,
  checkingMoves:rows.length,exactLegalSuccessors:rows.length,legalReplies:moves,legalSliderReplies:sliders},null,2));
