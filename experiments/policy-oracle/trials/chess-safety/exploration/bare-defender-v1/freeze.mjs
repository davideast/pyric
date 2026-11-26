import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import * as arcade from '../../../chess/reference/arcade-reference.ts';
import * as native from '../../../chess/reference/native.mjs';
import {position} from '../../../chess/reference/score.mjs';
import {nativeEvidence} from '../../reference/native.mjs';
import {plausible,encode} from '../v1/corpus.mjs';

const squares=Array.from({length:64},(_,i)=>i),densities=[2,3,5,8,12,15];
const selected=[],examples={},seen=new Set(),counterparts=[];
let state=0x416ce2a5;
const random=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/0x100000000*n);};
const pick=choices=>choices[random(choices.length)];
const dist=(a,b)=>Math.max(Math.abs((a>>3)-(b>>3)),Math.abs(a%8-b%8));
const uci=(a,b)=>arcade.squareName(a)+arcade.squareName(b);
function add(fen,move,group) {
  const key=fen+' '+move;
  if(seen.has(key)) return false;
  seen.add(key);selected.push({fen,uci:move,group});
  return true;
}
function flip({fen,uci:move,group}) {
  const p=position(fen),b=Array(64);
  for(let i=0;i<64;i++) b[i^56]=p.board[i]?(p.board[i][0]==='w'?'b':'w')+p.board[i][1]:'';
  const tr=s=>arcade.squareName(arcade.squareOf(s)^56);
  return {fen:encode({...p,board:b,turn:'b',castling:p.castling.toLowerCase()}),
    uci:tr(move.slice(0,2))+tr(move.slice(2,4))+move.slice(4),group};
}
function prior(next,to) {
  const piece=next.board[to],start=random(64);
  for(let n=0;n<64;n++) {
    const from=(start+n)%64;
    if(next.board[from] || piece==='wp' && (from<8||from>=56))continue;
    const b=[...next.board];b[from]=piece;b[to]='';
    const old={...next,board:b,turn:'w'};
    if(!arcade.isLegal(old,{from,to})||arcade.inCheck(old,'b')||!plausible(old))continue;
    const move=uci(from,to),after=native.apply(old,move);
    if(encode(after)!==encode(next))continue;
    return {fen:encode(old),move};
  }
}
for(let attempt=0;attempt<30000;attempt++) {
  const density=densities[attempt%densities.length],king=random(64);
  const enemy=random(2)?random(64):pick([0,7,56,63,1,6,8,15,48,55,57,62]);
  if(dist(king,enemy)<2)continue;
  const b=Array(64).fill('');b[king]='wk';b[enemy]='bk';
  const bag=[...'qrrbbnnpppppppp'];
  // Sparse ending receipts allow promoted armies. The full army has the
  // original material allotment, including opposite-color bishops.
  if(density<8) bag.push(...'qqrrbn');
  let placed=true;
  const bishopColors=[];
  for(let n=0;n<density;n++){
    const type=bag.splice(random(bag.length),1)[0];
    const spots=squares.filter(s=>!b[s] && (type!=='p'||s>=8&&s<56)
      && (type!=='b'||density<8||!bishopColors.includes(((s>>3)+(s%8))%2)));
    if(!spots.length){placed=false;break;}
    const spot=pick(spots);b[spot]='w'+type;
    if(type==='b')bishopColors.push(((spot>>3)+(spot%8))%2);
  }
  const next={board:b,turn:'b',castling:'',enPassant:-1};
  if(!placed||!plausible(next))continue;
  const outcome=native.outcome(next);
  const family=outcome==='playing'&&arcade.inCheck(next)?'playing-checked':outcome;
  for(const to of squares) {
    if(!b[to]||b[to][0]!=='w')continue;
    const group=['quiet',density,b[to][1],family].join('/');
    if((examples[group]??0)>=2)continue;
    const old=prior(next,to);
    if(old&&add(old.fen,old.move,group)) examples[group]=(examples[group]??0)+1;
  }
}
const ordinary=selected.slice();
const oppositeByResult={};
for(const c of ordinary) {
  const old=position(c.fen),next=native.apply(old,c.uci),outcome=native.outcome(next);
  if(outcome==='playing'||(oppositeByResult[outcome]??0)>=8)continue;
  const from=arcade.squareOf(c.uci.slice(0,2)),to=arcade.squareOf(c.uci.slice(2));
  let done=false;
  for(const loc of squares) {
    if(old.board[loc]||loc===to)continue;
    for(const piece of 'nrbqp') {
      if(piece==='p'&&(loc<8||loc>=56))continue;
      const b=[...old.board];b[loc]='b'+piece;
      const adjusted={...old,board:b};
      if(!plausible(adjusted)||!arcade.isLegal(adjusted,{from,to}))continue;
      const after=native.apply(adjusted,c.uci),replies=native.legalMoves(after);
      if(replies.length!==1||after.board[arcade.squareOf(replies[0].slice(0,2))]==='bk')continue;
      const fen=encode(adjusted);
      if(add(fen,c.uci,'nonbare/'+outcome+'/one-'+piece+'-reply')) {
        oppositeByResult[outcome]=(oppositeByResult[outcome]??0)+1;
        counterparts.push({bareFen:c.fen,fen,uci:c.uci,bareOutcome:outcome,defendingReply:replies[0]});
      }
      done=true;break;
    }
    if(done)break;
  }
}
const captures={};
for(const c of ordinary) {
  const old=position(c.fen),from=arcade.squareOf(c.uci.slice(0,2)),to=arcade.squareOf(c.uci.slice(2));
  const kind=old.board[from][1];
  if((captures[kind]??0)>=8)continue;
  const b=[...old.board];b[to]='bn';
  const adjusted={...old,board:b};
  if(!plausible(adjusted)||!arcade.isLegal(adjusted,{from,to}))continue;
  assert.equal(encode(native.apply(adjusted,c.uci)),encode(native.apply(old,c.uci)));
  if(add(encode(adjusted),c.uci,'capture-last-defender/'+kind))captures[kind]=(captures[kind]??0)+1;
}
for(const [fen,move] of [['k7/8/8/8/8/8/1B6/4K2R w K -','e1g1'],
                         ['7k/8/8/8/8/8/1N6/R3K3 w Q -','e1c1']])add(fen,move,'castle');
for(const piece of 'qrbn')add('7k/1P6/8/8/5B2/3R4/8/K7 w - -','b7b8'+piece,'promote/'+piece);
const rows=[];
for(const chosen of selected){
  for(const original of [chosen,flip(chosen)]) {
    const {fen,uci:move,group}=original,white=fen.split(' ')[1]==='w';
    for(const status of ['playing','won','draw']){
      const claim={status,winner:status==='won'?(white?'host':'guest'):''};
      const c={fen,uci:move,claim,id:'bare-'+String(rows.length+1).padStart(4,'0')},a=nativeEvidence([c]).cases[0];
      assert.ok(a.nativeLegal,c.id);
      const next=position(a.successor);
      assert.equal(next.board.filter(v=>v[0]===next.turn).length,group.startsWith('nonbare/')?2:1,c.id);
      rows.push({...c,group:(white?'w/':'b/')+group,kingSafe:a.kingSafe,nativeLegal:true,nativeAdmission:a.nativeAdmission,
        successor:a.successor,outcome:a.outcome,replyCount:a.replies.length,replySha256:sha(JSON.stringify(a.replies))});
    }
  }
}
const bytes=JSON.stringify(rows),summary={seed:'0x416ce2a5',densities,whiteSourceMoves:selected.length,
  ordinaryWhite:ordinary.length,writes:rows.length,terminalCounterparts:counterparts,quietSourceCoverage:examples,
  lastDefenderCaptures:captures,sha256:sha(bytes)};
const url=n=>new URL(n,import.meta.url);
if(process.argv[2]==='--freeze'){
  writeFileSync(url('corpus.json.gz'),gzipSync(bytes,{level:9}),{flag:'wx'});
  writeFileSync(url('freeze.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
}else{
  assert.deepEqual(JSON.parse(readFileSync(url('freeze.json'))),summary);
  assert.equal(gunzipSync(readFileSync(url('corpus.json.gz'))).toString(),bytes);
}
console.log(JSON.stringify(summary,null,2));
