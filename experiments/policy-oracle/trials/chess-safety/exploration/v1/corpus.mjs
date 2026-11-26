import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {position} from '../../../chess/reference/score.mjs';
import * as arcade from '../../../chess/reference/arcade-reference.ts';
import * as native from '../../../chess/reference/native.mjs';
import {nativeEvidence} from '../../reference/native.mjs';
import {sha} from '../../../../arcade/corpus.mjs';

const other=color=>color==='w'?'b':'w';
export function encode(p) {
  const ranks=Array.from({length:8},(_,r)=>p.board.slice(r*8,r*8+8)
    .map(v=>!v?'1':v[0]==='w'?v[1].toUpperCase():v[1]).join('').replace(/1+/g,s=>s.length));
  return [ranks.join('/'),p.turn,p.castling||'-',p.enPassant<0?'-':arcade.squareName(p.enPassant)].join(' ');
}
function random(seed) {
  let state=seed;
  return n=>{
    state=(Math.imul(1664525,state)+1013904223)>>>0;
    return Math.floor((state/0x100000000)*n);
  };
}
function transformed(c,mirror,swap) {
  const square=sq=>(mirror ? 7-sq%8 : sq%8)+8*(swap ? 7-Math.floor(sq/8) : Math.floor(sq/8));
  const p=position(c.fen), b=Array(64);
  for(const [i,v] of p.board.entries()) b[square(i)]=swap&&v?other(v[0])+v[1]:v;
  const translate=s=>arcade.squareName(square(arcade.squareOf(s)));
  // Horizontal reflection is restricted to positions without castling rights:
  // e-file kings cannot castle from a reflected d-file starting square.
  assert.ok(!mirror || !p.castling);
  const rights=swap?[...p.castling].map(s=>s===s.toUpperCase()?s.toLowerCase():s.toUpperCase()).join(''):p.castling;
  const fen=encode({board:b,turn:swap?other(p.turn):p.turn,castling:[...'KQkq'].filter(v=>rights.includes(v)).join(''),
    enPassant:p.enPassant<0?-1:square(p.enPassant)});
  const uci=translate(c.uci.slice(0,2))+translate(c.uci.slice(2,4))+c.uci.slice(4);
  let claim=c.claim;
  if(swap&&claim?.winner) claim={...claim,winner:claim.winner==='host'?'guest':'host'};
  return {fen,uci,...(claim && {claim})};
}
function addPieces(c,count,rng) {
  const p=position(c.fen), to=arcade.squareOf(c.uci.slice(2,4));
  const kinds=['p','n','b','r','q'];
  const empty=p.board.map((v,i)=>!v && i!==to && i!==p.enPassant?i:-1).filter(i=>i!==-1);
  for(let n=0;n<count&&empty.length;n++) {
    const i=empty.splice(rng(empty.length),1)[0],kind=kinds[rng(kinds.length)];
    if(kind==='p' && (i<8||i>=56)) continue;
    p.board[i]=(rng(2)?'w':'b')+kind;
  }
  return {...c,fen:encode(p)};
}

// The side which just moved cannot be in check. Retained rights must belong
// to actual kings and rooks. An en-passant marker must have a legal predecessor
// double step producing exactly this board and leaving the opponent king safe.
export function plausible(p) {
  for(const color of ['w','b']) {
    const pieces=p.board.filter(v=>v[0]===color);
    const count=kind=>pieces.filter(v=>v[1]===kind).length;
    if(count('k')!==1 || pieces.length>16 || count('p')>8) return false;
    const bishops=[0,0];
    for(const [i,v] of p.board.entries()) {
      if(v===color+'p' && (i<8||i>=56)) return false;
      if(v===color+'b') bishops[(i%8+Math.floor(i/8))%2]++;
    }
    const extra=(n,base)=>Math.max(0,n-base);
    const promoted=extra(count('r'),2)+extra(count('n'),2)+extra(count('q'),1)+bishops.reduce((n,k)=>n+extra(k,1),0);
    if(promoted>8-count('p')) return false;
  }
  if(arcade.inCheck(p,other(p.turn))) return false;
  for(const [right,k,r] of [['K',60,63],['Q',60,56],['k',4,7],['q',4,0]]) {
    if(!p.castling.includes(right)) continue;
    const color=k===4?'b':'w';
    if(p.board[k]!==color+'k' || p.board[r]!==color+'r') return false;
  }
  if(p.enPassant!==-1) {
    const color=other(p.turn), step=color==='w'?-8:8;
    const from=p.enPassant-step,to=p.enPassant+step;
    if(Math.floor(from/8)!==(color==='w'?6:1) || p.board[from] || p.board[p.enPassant] || p.board[to]!==color+'p') return false;
    const prior={...p,board:[...p.board],turn:color,enPassant:-1};
    prior.board[from]=prior.board[to];prior.board[to]='';
    if(arcade.inCheck(prior,p.turn) || !arcade.isLegal(prior,{from,to})) return false;
  }
  return true;
}

const roots=new URL('../../batches/',import.meta.url);
export function discoveryInputs() {
  const rng=random(0x246ece17), rows=[],seen=new Set();
  const key=c=>JSON.stringify([c.fen,c.uci,c.claim??null]);
  const selected=readdirSync(roots).filter(d=>/^[0-9]{2}-/.test(d)).sort().flatMap(group=>
    JSON.parse(readFileSync(new URL(group+'/v1/positions.json',roots))).map(base=>({group,base})));
  // All original primary positions stay in their own scored cohorts.
  for(const {base} of selected) seen.add(key(base));
  const legacy=new URL('../../../king-safety/reference/',import.meta.url);
  for(const name of ['positions','cost-position','path-cost-controls'])
    for(const c of JSON.parse(readFileSync(new URL(name+'.json',legacy)))) seen.add(key(c));
  function add(group,id,c) {
    const p=position(c.fen), k=key(c);
    if(seen.has(k) || !plausible(p)) return;
    const from=arcade.squareOf(c.uci.slice(0,2)),to=arcade.squareOf(c.uci.slice(2,4));
    if(p.board[from][0]!==p.turn || p.board[to][0]===p.turn || p.board[to]===other(p.turn)+'k') return;
    seen.add(k);
    rows.push({group,id,...c});
  }
  for(const {group,base} of selected) for(const swap of [false,true]) {
    for(const mirror of position(base.fen).castling?[false]:[false,true]) {
      const c=transformed(base,mirror,swap);
      for(const [i,n] of [0,1,2,3,5,8,12,16].entries()) {
        add(group,[base.id,Number(swap),Number(mirror),i].join('-'),addPieces(c,n,rng));
      }
    }
  }
  // Separate traces start from the opening. Every prefix is natively legal,
  // including real captures, checks, interpositions and rights expiry.
  for(let game=0;game<24;game++) {
    let p=arcade.initialPosition();
    for(let ply=0;ply<80;ply++) {
      const moves=native.legalMoves(p).sort();
      if(!moves.length) break;
      const uci=moves[rng(moves.length)];
      if(ply%2===1) add('reachable-traces','trace-'+game+'-'+ply,{fen:encode(p),uci});
      p=native.apply(p,uci);
    }
  }
  return rows;
}

export function freeze() {
  return discoveryInputs().map(input=>{
    const {group,...c}=input;
    const {cases:[a]}=nativeEvidence([c]);
    return {group,...c,kingSafe:a.kingSafe,nativeLegal:a.nativeLegal,nativeAdmission:a.nativeAdmission,
      successor:a.successor,outcome:a.outcome,replyCount:a.replies?.length??null,
      replySha256:a.replies===null?null:sha(JSON.stringify(a.replies)),
      ...(a.hypotheticalOutcomeDifference && {hypotheticalOutcomeDifference:a.hypotheticalOutcomeDifference})};
  });
}
