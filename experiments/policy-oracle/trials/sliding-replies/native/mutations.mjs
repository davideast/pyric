import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {position} from '../../chess/reference/score.mjs';
import {applyMove,inCheck,squareName} from '../../chess/reference/arcade-reference.ts';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const family = piece => ['r','b','q'].includes(piece[1]);

// Return all interior squares, or null if the slider has no ray to the target.
function interior(kind, from, to) {
  if (from===to) return null;
  const x=from%8, y=from>>3, dx=to%8-x, dy=(to>>3)-y;
  const diagonal=Math.abs(dx)===Math.abs(dy);
  if (!(diagonal && kind!=='r' || (!dx || !dy) && kind!=='b')) return null;
  const stride=Math.sign(dx)+8*Math.sign(dy), squares=[];
  for(let sq=from+stride; sq!==to; sq+=stride) squares.push(sq);
  return squares;
}

function witnesses(pos, mode) {
  const {board,turn}=pos, king=board.indexOf(turn+'k');
  const evasions=new Set();
  for(const [from,enemy] of board.entries()) {
    if (!family(enemy) || enemy[0]===turn) continue;
    const ray=interior(enemy[1],from,king);
    if (ray!==null && ray.every(sq=>!board[sq])) {
      for(const square of [from,...ray]) evasions.add(square);
    }
  }
  assert.ok(inCheck(pos) && evasions.size>0,'control expects a checking slider');
  const replies=[];
  for(const [from,piece] of board.entries()) {
    if (!family(piece) || piece[0]!==turn) continue;
    for(const to of evasions) {
      if(board[to][0]===turn || board[to][1]==='k') continue;
      const path=interior(piece[1],from,to);
      if (path===null || (mode!=='ignore-blockers' && path.some(sq=>board[sq]))) continue;
      const next=applyMove(pos,{from,to});
      if (mode!=='skip-post-reply-king-safety' && inCheck(next,turn)) continue;
      replies.push(squareName(from)+squareName(to));
    }
  }
  return replies.sort();
}

const modes=['ignore-blockers','skip-post-reply-king-safety'];
const observations=Object.fromEntries(modes.map(mode=>[mode,{firstDivergence:null,boards:[],claimErrors:[]}]));
let boards=0,claims=0;
for(const group of ['rook','bishop','queen']) {
  const rows=read(group+'/native.json').cases;
  for(let i=0;i<rows.length;i+=3) {
    const triple=rows.slice(i,i+3);
    const row=triple[0], pos=position(row.successor);
    assert.deepEqual(triple.map(r=>r.claim.status),['playing','draw','won']);
    for(const proposal of triple) {
      assert.equal(proposal.successor,row.successor);
      assert.deepEqual(proposal.replies,row.replies);
    }
    assert.deepEqual(witnesses(pos,'correct'),row.replies,row.id);
    boards++;claims+=triple.length;
    for(const mode of modes) {
      const observed=observations[mode], replies=witnesses(pos,mode);
      if(JSON.stringify(replies)===JSON.stringify(row.replies)) continue;
      const evidence={board:row.id.replace(/-playing$/,''),native:row.replies,mutated:replies};
      observed.firstDivergence??=evidence;
      observed.boards.push(evidence);
      const status=replies.length?'playing':'won';
      for(const proposal of triple) {
        const admission=proposal.claim.status===status;
        if(admission!==proposal.nativeAdmission) observed.claimErrors.push({id:proposal.id,native:proposal.nativeAdmission,mutant:admission});
      }
    }
  }
}
assert.deepEqual(observations['ignore-blockers'].firstDivergence,
  {board:'bishop-e5-d6-blocker',native:[],mutated:['e5b8']});
assert.deepEqual(observations['skip-post-reply-king-safety'].firstDivergence,
  {board:'bishop-b7-pinned',native:[],mutated:['b7c8']});
assert.ok(observations['skip-post-reply-king-safety'].boards.some(r=>
  r.board==='queen-capture-leaves-rook-check' && r.mutated.includes('f7d5')));
console.log(JSON.stringify({authority:'offline faulty slider-reply controls',boards,claims,observations},null,2));
