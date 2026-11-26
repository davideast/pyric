import assert from 'node:assert/strict';
import {position} from '../reference/score.mjs';
import {afterMove,fresh,snapshot,transition} from './document.mjs';
import {predictAdmission} from './admission.mjs';

const castle='k7/8/8/8/8/8/8/4K2R w K -';
const castleInAttack='k4r2/8/8/8/8/8/8/4K2R w K -';
const ep='4k3/8/8/5pPK/8/8/8/8 w - f6';
const epInAttack='4k3/8/8/r4pPK/8/8/8/8 w - f6';
const opening='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const cases=[
  ['signed-out',null,castle,'e1g1',16,401,'identity'],
  ['wrong-seat','guest',castle,'e1g1',16,409,'currentTurn'],
  ['stale-ply','host',castle,'e1g1',15,409,'matchVersion'],
  ['castle-through-check','host',castleInAttack,'e1g1',16,409,'legalMove'],
  ['castle-clear','host',castle,'e1g1',16,200,'committed'],
  ['ep-exposes-king','host',epInAttack,'g5f6',16,409,'legalMove'],
  ['ep-clear','host',ep,'g5f6',16,200,'committed'],
  ['occupied-seat-join','guest',opening],['wrong-resign-winner','guest',opening],['unfinished-parent-rematch','host',opening],
];

export function boundary(receipt,j,engine,matchPolicy) {
  const {host,guest,observer}=j.actors,decisions={},records=[];
  assert.equal(receipt.mode,'referee');assert.equal(receipt.cohort,'boundary');
  assert.deepEqual(receipt.rows.map(r=>r.id),cases.map(c=>'boundary-'+c[0]));
  assert.deepEqual(receipt.refereeRecords,j.all('referee'));
  for(const [i,[label,role,fen,uci,ply,status,requirement]] of cases.entries()){
    const r=receipt.rows[i], match=receipt.runId+'-'+r.id, path='chess/'+match;
    const join=label==='occupied-seat-join',offer=label==='unfinished-parent-rematch';
    const pos=position(fen),board=Object.fromEntries(pos.board.map((v,k)=>['abcdefgh'[k%8]+(8-Math.floor(k/8)),v]));
    const epName=fen.split(' ')[3];
    const openingDoc=fresh(host,{type:'firestore/timestamp/1.0',seconds:1767225600,nanoseconds:0});
    const seed={...openingDoc,guest:join?observer:guest,status:'playing',moveCount:16,board,prevBoard:board,
      castling:pos.castling,prevCastling:pos.castling,enPassant:epName==='-'?'':epName,prevEnPassant:epName==='-'?'':epName};
    const actor=role ? j.actors[role] : null;
    assert.deepEqual([r.actor,r.reader,r.probe],[actor,observer,{fen}],r.id);
    const paths=offer?[path,path+'-next','rematches/chess/matches/'+match]:[path];
    assert.deepEqual(r.before.map(s=>s.path),paths);assert.deepEqual(r.after.map(s=>s.path),paths);
    j.proof(r.proof);j.proof(r.end);
    const decision=requirement==='committed'?'ALLOW':'DENY';
    assert.deepEqual([r.observed,r.expected],[decision,decision],r.id);
    for(const [k,b] of r.before.entries()){
      snapshot(b,paths[k]);assert.deepEqual(b.data,k===0?seed:null);
      transition(b,r.after[k],k===0 && decision==='ALLOW'?afterMove(seed,uci):b.data,r.id);
    }
    if(uci){
      assert.deepEqual(r.submitted,[{op:'referee-move',path,ply,uci}]);
      assert.deepEqual([r.status,r.requirement],[status,requirement]);
      assert.deepEqual(predictAdmission(r,engine,matchPolicy),{observed:decision,after:r.after[0].data,status,requirement});
      if(actor!==null) {
        const rec=receipt.refereeRecords.find(x=>x.id===match);
        assert.ok(rec,r.id+' referee evidence');
        assert.deepEqual([rec.uid,rec.ply,rec.uci,rec.verdict],[actor,ply,uci,requirement]);
        j.proof(rec.proof);j.proof(rec.end);
        assert.deepEqual([rec.beforeVersion,rec.before,rec.afterVersion,rec.after],
          [r.before[0].version,seed,r.after[0].version,r.after[0].data]);
        assert.equal(rec.comparedVersion,decision==='ALLOW'?r.before[0].version:undefined);
        records.push(rec);
      }
    }else {
      assert.equal(r.status,undefined);assert.equal(r.requirement,undefined);
      if(offer) {
        const {createdAt,...next}=openingDoc;
        assert.deepEqual(r.submitted,[{op:'set',path:paths[1],data:{...next,rematchOf:match},serverTimestamp:['createdAt']},
          {op:'set',path:paths[2],data:{game:'chess',match:match+'-next',by:host}}]);
      }else assert.deepEqual(r.submitted,[{op:'update',path,data:join?{guest,status:'playing'}:{status:'resigned',winner:'guest'}}]);
    }
    decisions[r.id]=decision;
  }
  assert.deepEqual(receipt.refereeRecords,records);
  return decisions;
}
