import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {positions} from '../../reachable/v1/corpus.mjs';
import {position} from '../../../chess/reference/score.mjs';
import * as chess from '../../../chess/reference/native.mjs';
import * as standalone from '../../../chess/policies/chess.mjs';
import {squareName,squareOf,inCheck} from '../../../chess/reference/arcade-reference.ts';
const sha=s=>createHash('sha256').update(s).digest('hex');
const fens = new Map();
function add(f,origin){if(!fens.has(f))fens.set(f,origin);}
for(const {row,first} of positions())if(first)add(row.fen,'historical');
for(const cohort of ['replies-v1','interior-v1','king-last-v1','promotions-v1','en-passant-evasions-v1']){
  const rows=JSON.parse(gunzipSync(readFileSync(new URL('../../exploration/'+cohort+'/corpus.json.gz',import.meta.url))));
  for(const c of rows){add(c.fen,cohort);if(c.nativeLegal)add(c.successor,cohort+'-reply');}
}
// Expose the same pawn to a file pin, a diagonal pin or no pin on either color.
for(const [f,tag] of [
  ['4r2k/8/8/8/8/8/4P3/4K3 w - -','file-pinned'],
  ['4r2k/8/8/8/8/3n4/4P3/4K3 w - -','pinned-capture'],
  ['7k/8/8/8/7b/8/5P2/4K3 w - -','diagonal-pinned'],
  ['7k/8/8/8/7b/6n1/5P2/4K3 w - -','second-blocker'],
  ['r6k/1P6/8/8/8/8/8/K7 w - -','promoting-evasion'],
  ['4k3/4p3/3N4/8/8/8/8/4R2K b - -','black-pinned-capture'],
  ['k7/8/8/8/8/8/1p6/R6K b - -','black-promotion'],
]) add(f,tag);
const rows=[];
for(const [fen,origin] of fens){
  const p=position(fen);
  const legal=chess.legalMoves(p).sort();
  assert.deepEqual(standalone.legalMoves(p).sort(),legal);
  const replies=legal.filter(move=>p.board[squareOf(move.slice(0,2))]===p.turn+'p');
  const moves=replies.map(uci=>{
    const next=chess.apply(p,uci);
    assert.deepEqual(standalone.apply(p,uci),next);
    assert.equal(inCheck(next,p.turn),false);
    const from=squareOf(uci.slice(0,2)),to=squareOf(uci.slice(2,4));
    return {uci,kind:to===p.enPassant&&p.board[to]===''&&from%8!==to%8?'en-passant':
      Math.abs(from-to)===16?'double':p.board[to]?'capture':'advance'};
  });
  rows.push({id:'pawn-reply-'+rows.length,origin,fen,checked:inCheck(p,p.turn),pawnMoves:moves,allMoveCount:legal.length});
}
const bytes=JSON.stringify(rows), summary={authority:'pinned Arcade native with standalone move and successor cross-check',positions:rows.length,
  hasPawnReply:rows.filter(r=>r.pawnMoves.length).length,onlyPawnReplies:rows.filter(r=>r.pawnMoves.length&&r.pawnMoves.length===r.allMoveCount).length,
  checked:rows.filter(r=>r.checked).length,sha256:sha(bytes)};
const file=n=>new URL(n,import.meta.url);
if(process.argv[2]==='--freeze'){
  writeFileSync(file('corpus.json.gz'),gzipSync(bytes,{level:9}),{flag:'wx'});
  writeFileSync(file('native.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
}else{
  assert.equal(gunzipSync(readFileSync(file('corpus.json.gz'))).toString(),bytes);
  assert.deepEqual(JSON.parse(readFileSync(file('native.json'))),summary);
}
console.log(JSON.stringify(summary));
