import {pieces,verdict} from './endings.mjs';
import {squares,touching} from '../v1/geometry.mjs';
const index=s=>s%8+(s>>3)*10;

function repeat(n){return n===0?'':n===1?',':',{'+n+'}';}
function gaps(input){
  const values=[...new Set(input)].sort((a,b)=>a-b);
  const groups=[];
  for(let i=0;i<values.length;i++){
    const lo=values[i];
    while(i+1<values.length&&values[i+1]===values[i]+1)i++;
    const hi=values[i];
    groups.push(lo===hi?repeat(lo):',{'+lo+','+hi+'}');
  }
  return groups.length===1?groups[0]:'(?:'+groups.join('|')+')';
}
function pattern(s,piece,status) {
  const pairs=new Map();
  for(let d=0;d<64;d++)for(let a=0;a<64;a++){
    if(s===d||s===a||touching(a,d)||verdict(piece,s,d,a)!==status)continue;
    const lo=Math.min(index(a),index(d)), hi=Math.max(index(a),index(d));
    const first=index(a)===lo?'w':'b';
    const key=first+lo;
    if(!pairs.has(key))pairs.set(key,{lo,first,gaps:[]});
    pairs.get(key).gaps.push(hi-lo); // the lower king's terminating comma is included
  }
  if(!pairs.size)return null;
  return '(?:'+[...pairs.values()].map(g=>repeat(g.lo)+g.first+gaps(g.gaps)+(g.first==='w'?'b':'w')).join('|')+'),*';
}
export function patternSources() {
  const out={};
  for(let s=0;s<64;s++){
    const kinds=pieces.map(piece=>{
      const match=label=>{const re=pattern(s,piece,label);return re?"kings.matches('"+re+"')":'false';};
      return "("+match('won')+" ? status == 'won' : "+match('draw')+" ? status == 'draw' : status == 'playing')";
    });
    const name='terminal'+squares[s];
    out[name]=`function ${name}(kings,kind,status) { return kind == 'r' ? ${kinds[0]} : kind == 'q' ? ${kinds[1]} : kind == 'b' ? ${kinds[2]} : ${kinds[3]}; }`;
  }
  return out;
}
function branch(lo,hi){
  if(lo===hi)return 'terminal'+squares[lo]+'(kings,kind,status)';
  const m=(lo+hi)>>1;
  return '(square <= '+m+' ? '+branch(lo,m)+' : '+branch(m+1,hi)+')';
}
export function patternGuard(){
  return `function endingTable(text,color,square,piece,status) {
    let stripped = text.split('#|[wb][qrnb]|k').join('');
    let kings = color == 'w' ? stripped : stripped.split('w').join('X').split('b').join('w').split('X').join('b');
    let kind = piece[1:2];
    return ${branch(0,63)};
  }`;
}
