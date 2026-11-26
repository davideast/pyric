import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import * as arcade from '../../../chess/reference/arcade-reference.ts';
import * as native from '../../../chess/reference/native.mjs';
import {position} from '../../../chess/reference/score.mjs';
import {nativeEvidence} from '../../reference/native.mjs';
import {plausible,encode} from '../v1/corpus.mjs';
import {reverseMove} from '../replies-v1/reverse.mjs';

const squares=Array.from({length:64},(_,i)=>i),edge=squares.filter(i=>i%8===0||i%8===7||i<8||i>55);
const directions=[[0,1],[1,0],[0,-1],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];
const selected=[],counts={},seen=new Set(),twins=[];
let seed=0x289c2141;
const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/0x100000000*n);};
const pick=xs=>xs[random(xs.length)];
const square=(x,y)=>x<0||x>=8||y<0||y>=8?-1:x+y*8;
function mirror(c){
  const p=position(c.fen),b=Array(64);
  for(let i=0;i<64;i++)b[i^56]=p.board[i]?(p.board[i][0]==='w'?'b':'w')+p.board[i][1]:'';
  const mirrorSquare=s=>arcade.squareName(arcade.squareOf(s)^56);
  return {...c,fen:encode({...p,board:b,turn:p.turn==='w'?'b':'w'}),
    uci:mirrorSquare(c.uci.slice(0,2))+mirrorSquare(c.uci.slice(2,4))};
}
function geometry(p){
  const own=p.turn,other=own==='w'?'b':'w',king=p.board.indexOf(own+'k');
  const knights=squares.filter(s=>p.board[s]===own+'n');
  const legal=native.legalMoves(p).sort(),knightLegal=legal.filter(u=>knights.includes(arcade.squareOf(u.slice(0,2))));
  const pseudo=[];
  for(const n of knights)for(const to of squares) {
    const dx=Math.abs(n%8-to%8),dy=Math.abs((n>>3)-(to>>3));
    if(dx*dy===2&&p.board[to][0]!==own&&p.board[to]!==other+'k')pseudo.push(arcade.squareName(n)+arcade.squareName(to));
  }
  const pinned=[];
  for(const [dx,dy] of directions){
    let first=false;
    for(let n=1;n<8;n++){
      const s=square(king%8+dx*n,(king>>3)+dy*n);
      if(s<0)break;
      const piece=p.board[s];if(!piece)continue;
      if(first===false && piece===own+'n'){first=s;continue;}
      if(first!==false && piece[0]===other && (piece[1]==='q'||piece[1]===(dx&&dy?'b':'r')))pinned.push({knight:first,pinner:s});
      break;
    }
  }
  return {knights,legal,knightLegal,pseudo:pseudo.sort(),pinned,check:arcade.inCheck(p)};
}
function categories(p,info){
  if(!info.pseudo.length||info.legal.length!==info.knightLegal.length)return [];
  const pin=info.pinned.length?'pinned':'free';
  if(!info.legal.length)return [(info.check?'mate':'stalemate')+'-'+pin];
  const types=new Set(info.knightLegal.map(u=>p.board[arcade.squareOf(u.slice(2))]?'capture':'quiet'));
  return [...types].map(k=>(info.check?'check-':'unchecked-')+(info.check&&k==='quiet'?'interpose':k)+'-'+pin);
}
function enroll(c,group) {
  const key=c.fen+' '+c.uci;if(seen.has(key))return false;
  seen.add(key);selected.push({...c,group});return true;
}
for(let attempt=0;attempt<100000;attempt++){
  const k=attempt%3?pick(edge):random(64),nKnights=attempt%2+1,b=Array(64).fill('');
  b[k]='bk';
  const free=()=>pick(squares.filter(s=>!b[s]));
  // Construct a line through a defending knight in half the candidates.
  if(attempt%4<2){
    const [dx,dy]=pick(directions),line=[];
    for(let j=1;j<8;j++){const t=square(k%8+dx*j,(k>>3)+dy*j);if(t<0)break;line.push(t);}
    if(line.length<2)continue;
    const idx=random(line.length-1);
    b[line[idx]]='bn';b[pick(line.slice(idx+1))]='w'+pick([dx&&dy?'b':'r','q']);
  }else b[free()]='bn';
  if(nKnights===2)b[free()]='bn';
  b[free()]='wk';
  for(let j=0,n=2+random(4);j<n;j++)b[free()]='w'+pick(['q','r','q','n','b']);
  const next={board:b,turn:'b',castling:'',enPassant:-1};
  if(!plausible(next))continue;
  const info=geometry(next),groups=categories(next,info).map(kind=>nKnights+'/'+kind);
  let group=groups.find(f=>(counts[f]??0)<4);
  if(!group)continue;
  const attackers=squares.filter(s=>b[s][0]==='w');
  let old;
  for(const s of attackers){old=reverseMove(next,s,random);if(old)break;}
  if(!old||!enroll(old,group))continue;
  counts[group]=(counts[group]??0)+1;
  if(info.legal.length||!info.pinned.length||twins.length>=12)continue;
  const prior=position(old.fen);
  for(const pin of info.pinned) {
    if(old.uci.includes(arcade.squareName(pin.pinner)))continue;
    const b2=[...prior.board];b2[pin.pinner]='';
    const changed={...prior,board:b2};
    if(!plausible(changed)||!native.legalMoves(changed).includes(old.uci))continue;
    const comp=geometry(native.apply(changed,old.uci));
    if(!comp.legal.length||comp.legal.length!==comp.knightLegal.length)continue;
    const fen=encode(changed);
    if(enroll({fen,uci:old.uci},nKnights+'/removed-pinner'))twins.push({pinned:old.fen,unblocked:fen,uci:old.uci,
      pinner:arcade.squareName(pin.pinner),legalKnightReplies:comp.knightLegal});
  }
}
// The edge knights are pinned by separate bishops. The enemy knight covers
// both empty king destinations. Only the interior knight can play a real reply.
enroll({fen:'k7/8/8/8/2n5/2b3b1/3NNN2/4K3 b - -',uci:'c4e3'},'3/only-middle-knight');
const rows=[];
for(const chosen of selected)for(const c of [chosen,mirror(chosen)]) {
  const p=position(c.fen),next=native.apply(p,c.uci),info=geometry(next),winner=p.turn==='w'?'host':'guest';
  if(c.group.startsWith('3/')){
    assert.equal(info.pinned.length,2);assert.equal(info.knights.length,3);
    assert.ok(info.legal.length&&info.legal.every(u=>u[0]==='e'&&next.board[arcade.squareOf(u.slice(0,2))]===next.turn+'n'));
  }
  assert.equal(info.legal.length,info.knightLegal.length);
  for(const status of ['playing','won','draw']){
    const claim={status,winner:status==='won'?winner:''},id='knight-reply-'+String(rows.length+1).padStart(3,'0');
    const a=nativeEvidence([{id,fen:c.fen,uci:c.uci,claim}]).cases[0];assert.ok(a.nativeLegal);
    assert.deepEqual(a.replies,info.legal);
    rows.push({id,fen:c.fen,uci:c.uci,claim,group:next.turn+'/'+c.group,kingSafe:true,nativeLegal:true,
      nativeAdmission:a.nativeAdmission,successor:a.successor,outcome:a.outcome,replyCount:a.replies.length,
      replySha256:sha(JSON.stringify(a.replies)),legalKnightReplies:info.knightLegal,pseudoKnightReplies:info.pseudo,
      pinnedKnights:info.pinned.map(v=>arcade.squareName(v.knight)).sort()});
  }
}
for(const required of ['1/check-capture-free','1/check-interpose-free','1/mate-pinned','1/stalemate-pinned',
  '2/check-capture-pinned','2/check-interpose-pinned'])assert.ok(counts[required],required);
assert.ok(twins.length);
const bytes=JSON.stringify(rows),frozen={seed:'0x289c2141',sourceMoves:selected.length*2,writes:rows.length,counts,twins,sha256:sha(bytes)};
const url=n=>new URL(n,import.meta.url);
if(process.argv[2]==='--freeze'){
  writeFileSync(url('corpus.json.gz'),gzipSync(bytes,{level:9}),{flag:'wx'});
  writeFileSync(url('freeze.json'),JSON.stringify(frozen,null,2)+'\n',{flag:'wx'});
}else{
  assert.deepEqual(JSON.parse(readFileSync(url('freeze.json'))),frozen);
  assert.equal(gunzipSync(readFileSync(url('corpus.json.gz'))).toString(),bytes);
}
console.log(JSON.stringify(frozen,null,2));
