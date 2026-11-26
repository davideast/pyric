import {pieces,verdict} from '../terminal/table-v2/endings.mjs';
import {touching} from '../terminal/v1/geometry.mjs';
import {packedSources} from '../policy/packed.mjs';

const padded=s=>s%8+(s>>3)*10;
const rows=[];
for(const kind of pieces) for(let s=0;s<64;s++) for(let d=0;d<64;d++) for(let a=0;a<64;a++) {
  if(s===d || s===a || touching(a,d)) continue;
  const status=verdict(kind,s,d,a);
  if(status==='playing') continue;
  rows.push({status,kind,cells:[[padded(s),'p'],[padded(a),'a'],[padded(d),'d']].sort((a,b)=>a[0]-b[0])});
}
const choice=items=>items.length===1?items[0]:'(?:'+items.join('|')+')';
function gaps(nums) {
  const values=[...new Set(nums)].sort((a,b)=>a-b);
  const out=[];
  for(let i=0;i<values.length;i++) {
    const start=values[i];
    while(i+1<values.length&&values[i+1]===values[i]+1)i++;
    const end=values[i];
    out.push(start===end?(start===0?'':start===1?',':',{'+start+'}'):',{'+start+','+end+'}');
  }
  return choice(out);
}
function trie(paths) {
  if(!paths.length || !paths[0].length) return ',*';
  const branches=new Map();
  for(const [first,...rest] of paths) {
    const [dist,type]=first;
    const key=dist+type;
    if(!branches.has(key))branches.set(key,{dist,type,rest:[]});
    branches.get(key).rest.push(rest);
  }
  const groups=new Map();
  for(const {dist,type,rest} of branches.values()) {
    const tail=type+trie(rest);
    if(!groups.has(tail))groups.set(tail,[]);
    groups.get(tail).push(dist);
  }
  return choice([...groups].map(([tail,dist])=>gaps(dist)+tail));
}
export function threePatterns(color,status) {
  const other=color==='w'?'b':'w';
  const paths=rows.filter(r=>status==='either'||r.status===status).map(({cells,kind})=>cells.map(([i,k],n)=>[
    n===0?i:i-cells[n-1][0], k==='p'?color+kind:k==='a'?color+'k':other+'k',
  ]));
  const groups=[];
  function push(bucket) {
    const expr=trie(bucket);
    if(expr.length<=6400) {groups.push(expr);return;}
    const sorted=bucket.toSorted((a,b)=>a[0][0]-b[0][0]||a[0][1].localeCompare(b[0][1])||a[1][0]-b[1][0]);
    const m=sorted.length>>1;
    push(sorted.slice(0,m));push(sorted.slice(m));
  }
  push(paths);
  return groups;
}

export function threeSources() {
  const out={};
  for(const color of ['w','b']) for(const status of ['won','draw','either']) {
    const name='three'+color+status;
    const patterns=threePatterns(color,status);
    patterns.forEach((re,i)=>{
      const key=patterns.length===1?name:name+i;
      out[key]='function '+key+"(flat) { return flat.matches('"+re+"'); }";
    });
  }
  return out;
}

const material=color=>'(?:[,#]|[wb]k,)*'+color+'[rqbn],(?:[,#]|[wb]k,)*';

export function compileThree(compileFunction,{mode}) {
  const sources=threeSources();
  const compiled=Object.fromEntries(Object.entries(sources).map(([key,src])=>[key,compileFunction(src)]));
  const pack=compileFunction(packedSources(true).packNormal);
  const eligible=compileFunction(`function eligible(text,color) { return text.matches(color=='w' ? '${material('w')}' : '${material('b')}'); }`);
  const flatten=compileFunction("function flatten(text) { return text.replace('#',''); }");
  const modules=mode==='standalone'?{}:Object.fromEntries(Object.entries(compiled).map(([k,fn])=>[k,fn.firestoreModule()]));
  function threePieceStatus(board,color) {
    const text=pack(board);
    if(!eligible(text,color))return null;
    const flat=flatten(text);
    const matches=status=>Object.entries(compiled).some(([key,fn])=>key.startsWith('three'+color+status)&&fn(flat));
    return matches('won') ? 'won' : matches('draw') ? 'draw' : 'playing';
  }
  return {modules,threePieceStatus};
}

export function terminalEnvelope() {
  const gap=n=>n?'(?:[^,]*,){'+n+'}':'';
  const near=[2,8,12,18,19,20,21,22].map(offset=>gap(offset-1)).join('|');
  const kings='.*[wb]k,(?:'+near+')[wb]k,.*';
  const queens=[];
  for(const corner of [0,7,56,63]) for(let q=0;q<64;q++) {
    if(Math.abs(q%8-corner%8)*Math.abs((q>>3)-(corner>>3))!==2)continue;
    const [lo,hi]=[padded(corner),padded(q)].sort((a,b)=>a-b);
    const first=lo===padded(corner)?'[wb]k,':'[wb]q,';
    const second=lo===padded(corner)?'[wb]q,':'[wb]k,';
    queens.push(gap(lo)+first+gap(hi-lo-1)+second+'.*');
  }
  return '(?:'+[kings,...queens].join('|')+')';
}

export function wholeBinding(source,fast=false) {
  if(source!=='return packedSafe(text, color);') throw Error('unexpected base safety binding');
  const state='castle ? castleFinish(text,color,xTo) : text';
  const test=fast? 'return packedSafe(text, color) && quickWhole('+state+',color,next.status);'
    : 'return packedSafe(text, color) && wholeStatus('+state+',color,next.status);';
  const helpers=`
  function castleFinish(text,color,xTo) {
    return color == 'w'
      ? (xTo == 6 ? text.replace('wk,wk,wk,wr,',',wr,wk,,') : text.replace('wr,,wk,wk,wk,',',,wk,wr,,'))
      : (xTo == 6 ? text.replace('bk,bk,bk,br,',',br,bk,,') : text.replace('br,,bk,bk,bk,',',,bk,br,,'));
  }
  function exactThree(flat,white,status) {
    return white ? (status=='playing' ? !threeweither(flat) : status=='won' ? threewwon(flat) : threewdraw(flat))
                 : (status=='playing' ? !threebeither(flat) : status=='won' ? threebwon(flat) : threebdraw(flat));
  }
  function wholeStatus(text,color,status) {
    let white = color == 'w';
    let exact = text.matches(white ? '${material('w')}'
                                   : '${material('b')}');
    return exact ? exactThree(text.replace('#',''),white,status) : status == 'playing'
        || (packedSafe(text,white ? 'b':'w') == (status=='draw')
          && !replyCapture(text,color) && !hasKingReply(text,white ? 'b':'w'));
  }`;
  const sections=fast?[`function quickWhole(text,color,status) {
     return (status == 'playing' && !text.matches('${terminalEnvelope()}')) || wholeStatus(text,color,status);
   }`]:[];
  for(const color of ['w','b']) for(const status of ['won','draw','either']) {
    const parts=threePatterns(color,status);
    if(parts.length===1)continue;
    const name='three'+color+status;
    sections.push('function '+name+'(flat) { return '+parts.map((_,i)=>name+i+'(flat)').join(' || ')+'; }');
  }
  return {test,helpers:sections.join('\n')+helpers};
}
