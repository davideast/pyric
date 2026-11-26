import assert from 'node:assert/strict';
import {position} from '../reference/score.mjs';
import * as native from '../reference/native.mjs';
import {afterMove, fresh, movePatch, snapshot, transition} from './document.mjs';

const positions = {
  castle:'r3k2r/8/8/8/8/8/8/R3K2R b KQkq -',
  throughCheck:'4kr2/8/8/8/8/8/8/4K2R w K -',
  ep:'4k3/8/8/3pP3/8/8/8/4K3 w - d6',
  promotion:'1r5k/P7/8/8/8/8/8/K7 w - -',
  clearRay:'8/8/7k/8/8/8/8/Q4K2 w - -',
  blockedRay:'8/8/7k/8/8/8/P7/Q4K2 w - -',
  stalemate:'7k/5K2/8/8/4Q3/8/8/8 w - -',
};
const probes = [
  ['castle-black-queenside','castle','e8c8'],['castle-rook-arrival','castle','e8c8','modified'],
  ['castle-attacked-transit','throughCheck','e1g1','standalone'],['capture-corner-rights','castle','a8a1'],
  ['capture-retains-rights','castle','a8a1','modified'],['en-passant','ep','e5d6'],
  ['en-passant-captured-pawn','ep','e5d6','modified'],['en-passant-expires','ep','e5e6','modified'],
  ['underpromotion-capture','promotion','a7b8n'],['promotion-required','promotion','a7a8','modified'],
  ['long-clear-ray','clearRay','a1a8'],['long-blocked-ray','blockedRay','a1a8','modified'],
  ['stalemate','stalemate','e4g6'],['ongoing-vs-terminal','clearRay','a1a8','standalone'],
];
const name=i=>'abcdefgh'[i%8]+(8-Math.floor(i/8));
export function specials(receipt,actors,proof) {
  const rows=receipt.rows.filter(r=>r.id.startsWith('special-'));
  if (!rows.length && receipt.mode==='stock' && !receipt.rows[0].submitted) return {};
  const selected=probes.filter(([, , ,kind])=>!kind || receipt.mode==='referee' || receipt.mode==='stronger' && kind!=='standalone');
  assert.deepEqual(rows.map(r=>r.id),selected.map(([id])=>'special-'+id));
  const decisions={};
  for(const [i,[id,key,uci,kind]] of selected.entries()){
    const r=rows[i], path='chess/'+receipt.runId+'-'+r.id;
    const [b]=r.before,[a]=r.after;
    assert.equal(r.before.length,1); assert.equal(r.after.length,1);
    snapshot(b,path); snapshot(a,path); proof(r.proof);proof(r.end);
    assert.deepEqual(r.probe,{position:key,uci});
    const pos=position(positions[key]), board=Object.fromEntries(pos.board.map((p,i)=>[name(i),p]));
    const ep=pos.enPassant===-1?'':name(pos.enPassant);
    const seed={...fresh(actors.host,{type:'firestore/timestamp/1.0',seconds:1767225600,nanoseconds:0}),
      guest:actors.guest,board,prevBoard:board,status:'playing',moveCount:16,currentTurn:pos.turn==='w'?'host':'guest',
      castling:pos.castling,prevCastling:pos.castling,enPassant:ep,prevEnPassant:ep};
    assert.deepEqual(b.data,seed,id+' full seeded board');
    assert.equal(r.actor,actors[seed.currentTurn]);
    const patch=movePatch(afterMove(seed,uci,native,!['castle-attacked-transit','promotion-required','long-blocked-ray'].includes(id)));
    if(id==='castle-rook-arrival') patch.board.d8='';
    if(id==='capture-retains-rights') patch.castling='KQkq';
    if(id==='en-passant-captured-pawn') patch.board.d5='bp';
    if(id==='en-passant-expires') patch.enPassant='d6';
    if(id==='ongoing-vs-terminal'){patch.status='won';patch.winner='host';}
    assert.deepEqual(r.proposal,patch,id+' proposed update');
    if(r.submitted) assert.deepEqual(r.submitted,[{op:'update',path,data:patch}]);
    if(r.reader) assert.equal(r.reader,actors.observer);
    const decision=receipt.mode==='referee' || (receipt.mode==='stronger' && kind==='modified') ? 'DENY':'ALLOW';
    assert.deepEqual([r.expected,r.observed],[decision,decision],id);
    transition(b,a,decision==='ALLOW'?{...seed,...patch}:seed,id);
    decisions[r.id]=r.observed;
  }
  return decisions;
}
