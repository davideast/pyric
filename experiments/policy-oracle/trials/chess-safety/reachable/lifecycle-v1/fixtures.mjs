import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {gunzipSync} from 'node:zlib';
import {fresh,priorPosition,afterMove} from '../../../chess/verify/document.mjs';
import {position} from '../../../chess/reference/score.mjs';
import * as native from '../../../chess/reference/native.mjs';
import * as boardPolicy from '../../../chess/policies/chess.mjs';
import * as matchPolicy from '../../../chess/policies/chess-match.mjs';
import {fixedCreatedAt} from '../../../for-of/live/fixtures.mjs';
import {sample} from '../../reference/fixtures.mjs';

export const stamp='2026-01-01T00:00:00Z';
const opening='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const actors={host:'white-player',guest:'black-player'};
const archive=readFileSync(new URL('../../../chess/reference/public.json.gz',import.meta.url));
export const corpusSha=createHash('sha256').update(archive).digest('hex');
assert.equal(corpusSha,'c2a0ee05ec81ce32998cb58281363a3a96cdee07b950fb697df204283d6e6d71');
const catalog=JSON.parse(gunzipSync(archive));assert.equal(catalog.engine,'python-chess 1.11.2');
export const traces=catalog.traces;
function sorted(value){
  if(Array.isArray(value))return value.map(sorted);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])]));
  return value;
}
export const canonical=value=>JSON.stringify(sorted(value));
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const id=(phase,ply)=>phase+'-'+ply;

function probes(before,next,move) {
  const {from,to}=next.lastMove,actor=actors[before.currentTurn],other=actor===actors.host?actors.guest:actors.host;
  const out=[{kind:'wrong-seat',actor:other,data:next},
    {kind:'old-ply',actor,data:{...next,moveCount:before.moveCount}}];
  for(const status of ['playing','won','draw'])if(status!==next.status)
    out.push({kind:'claim-'+status,actor,data:{...next,status,winner:status==='won'?before.currentTurn:''}});
  if(!isDeepStrictEqual(before.prevBoard,before.board))
    out.push({kind:'stale-previous-board',actor,data:{...next,prevBoard:before.prevBoard}});
  if(before.board[to])
    out.push({kind:'captured-piece-restored',actor,data:{...next,board:{...next.board,[from]:before.board[to]}}});
  if(next.lastMove.extra.length) {
    const kind=before.board[from][1]==='k'?'castle-rook-unmoved':'en-passant-victim-restored';
    const b={...next.board};
    for(const square of next.lastMove.extra)b[square]=before.board[square];
    out.push({kind,actor,data:{...next,board:b}});
  }
  return out;
}

export function* steps(trace) {
  const openingGame=trace.rows[0].fen===opening;
  let before;
  if(openingGame){
    const waiting=fresh(actors.host,fixedCreatedAt);
    yield {id:id('create',0),kind:'create',ply:0,method:'create',actor:actors.host,before:null,
      submitted:{...waiting,createdAt:{__type:'serverTimestamp'}},after:waiting,
      probes:[{kind:'other-creates-for-host',actor:actors.guest,data:{...waiting,createdAt:{__type:'serverTimestamp'}}}]};
    before={...waiting,status:'playing',guest:actors.guest};
    yield {id:id('join',0),kind:'join',ply:0,method:'update',actor:actors.guest,before:waiting,
      submitted:before,after:before,probes:[{kind:'host-claims-second-seat',actor:actors.host,data:{...before,guest:actors.host}}]};
  }else{
    const first=trace.rows[0],white=first.fen.split(' ')[1]==='w';
    const seed=sample({fen:first.fen,uci:first.move},white?actors.host:actors.guest,white?actors.guest:actors.host).before;
    before={...seed,moveCount:white?16:17};
    yield {id:id('seed',0),kind:'seed',ply:0,after:before};
  }
  for(let ply=0;ply<trace.rows.length-1;ply++){
    const row=trace.rows[ply],next=trace.rows[ply+1],move=row.move;
    const actor=actors[before.currentTurn];
    assert.ok(row.legal.includes(move));
    assert.equal(before.currentTurn,before.moveCount%2===0?'host':'guest');
    assert.equal(matchPolicy.admit(before,actor,before.moveCount),'ok');
    assert.deepEqual(priorPosition(before),position(row.fen));
    const after=afterMove(before,move,native,true);
    assert.deepEqual(after,afterMove(before,move,boardPolicy,true,matchPolicy));
    assert.deepEqual(priorPosition(after),position(next.fen));
    assert.equal(after.status,{playing:'playing',checkmate:'won',stalemate:'draw'}[next.outcome]);
    yield {id:id('move',ply+1),kind:'move',ply:ply+1,uci:move,method:'update',actor,before,
      submitted:after,after,probes:probes(before,after,move)};
    before=after;
  }
}

export const sourceKind=trace=>trace.rows[0].fen===opening?'standard-opening':'composed-seed';
