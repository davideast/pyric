import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {positions} from '../../reachable/v1/corpus.mjs';
import {position} from '../../../chess/reference/score.mjs';
import * as native from '../../../chess/reference/native.mjs';
import * as ts from '../../../chess/reference/arcade-reference.ts';
import * as pyric from '../../../chess/policies/chess.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');
const src=readFileSync(new URL('../../../chess/reference/arcade-reference.ts',import.meta.url),'utf8');
assert.equal(sha(src),'1f321bbb70128936c00283d22cfe03ad84b8907a00f0dacf3363b694d6534d5e');
const marker='function pseudoMoves(pos: Position): Move[]';
assert.equal(src.split(marker).length,2);
const js=new Bun.Transpiler({loader:'ts'}).transformSync(src.replace(marker,'export '+marker));
const {pseudoMoves}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
function fen(p){
  const ranks=Array.from({length:8},(_,i)=>p.board.slice(8*i,8*i+8).map(piece=>
    !piece?'1':piece[0]==='w'?piece[1].toUpperCase():piece[1]).join('').replace(/1+/g,s=>s.length));
  return [ranks.join('/'),p.turn,p.castling||'-',p.enPassant<0?'-':ts.squareName(p.enPassant)].join(' ');
}
const map=new Map();
for(const {row,first} of positions())if(first)map.set(row.fen,'previous-traces');
const specification=JSON.parse(readFileSync(new URL('../../../chess/reference/public.json',import.meta.url)));
const walked=new Map();
function walk(p,depth,origin){
  const key=fen(p);
  map.set(key,map.get(key)??origin);
  if(depth===0 || (walked.get(key)??0)>=depth)return;
  walked.set(key,depth);
  for(const move of native.legalMoves(p))walk(native.apply(p,move),depth-1,origin);
}
for(const seed of specification.positions){
  const depth=seed.name==='kiwipete'?2:1;
  walk(position(seed.fen==='startpos'?'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -':seed.fen),depth,'perft-'+seed.name);
}
function castleWhenGeometryPermits(p) {
  // Include a transit-only exposure even when the pinned engine filters it in pseudoMoves.
  const r=p.turn==='w'?'1':'8',base='e'+r;
  if(p.board[ts.squareOf(base)]!==p.turn+'k')return [];
  return [['K','h','fg','g'],['Q','a','bcd','c']].flatMap(([right,rook,path,to])=>{
    if(!p.castling.includes(p.turn==='w'?right:right.toLowerCase())||
       p.board[ts.squareOf(rook+r)]!==p.turn+'r'||[...path].some(f=>p.board[ts.squareOf(f+r)]!==''))return [];
    return [base+to+r];
  });
}
function uci(m){return ts.squareName(m.from)+ts.squareName(m.to)+(m.promotion??'');}
const rows=[], counts={}, outcomes=createHash('sha256');
for(const [f,origin] of map){
  const p=position(f);
  const legal=native.legalMoves(p).sort(), approved=new Set(legal);
  assert.deepEqual(pyric.legalMoves(p).sort(),legal);
  const proposed=new Set([...pseudoMoves(p).map(uci),...castleWhenGeometryPermits(p)]);
  for(const m of legal)assert.ok(proposed.has(m),f+' '+m);
  const hard=[...proposed].filter(m=>!approved.has(m)).sort();
  if(!hard.length)continue;
  const chosen=new Set(hard);
  for(const m of hard){
    const control=legal.find(l=>l.slice(0,2)===m.slice(0,2))??legal[0];
    if(control)chosen.add(control);
  }
  for(const m of chosen){
    const next=native.apply(p,m);
    const from=ts.squareOf(m.slice(0,2)),to=ts.squareOf(m.slice(2,4)),kind=p.board[from][1];
    assert.notEqual(p.board[to],(p.turn==='w'?'b':'w')+'k',f);
    const castle=kind==='k'&&Math.abs(from-to)===2;
    const after=ts.inCheck(next,p.turn);
    const starts=ts.inCheck(p,p.turn);
    let transit=false;
    if(castle)transit=ts.inCheck(ts.applyMove(p,{from,to:(from+to)/2}),p.turn);
    const legalMove=approved.has(m);
    assert.equal(legalMove,!after&&(!castle||(!starts&&!transit)),f+' '+m);
    const group=legalMove?'legal-control':castle?'castle-safety':starts?'unanswered-check':
      kind==='k'?'king-destination':'newly-exposed';
    const id='safety-'+rows.length;
    const successor=fen(next);
    rows.push({id,fen:f,uci:m,nativeAdmission:legalMove,group,origin});
    outcomes.update(JSON.stringify([id,f,m,successor,legalMove,starts,transit,after])+'\n');
    counts[group]=(counts[group]??0)+1;
  }
}
const bytes=Buffer.from(JSON.stringify(rows));
const metadata={authority:'pinned Arcade native and independent standalone legal lists',boards:map.size,
  writes:rows.length,counts,inputsSha256:sha(bytes),successorsSha256:outcomes.digest('hex')};
if(process.argv.includes('--write')) {
  const {writeFileSync}=await import('node:fs');
  writeFileSync(new URL('corpus.json.gz',import.meta.url),gzipSync(bytes,{level:9}));
}
console.log(JSON.stringify(metadata,null,2));
