import assert from 'node:assert/strict';
import {pieces,tile} from './endings.mjs';
import {replySource} from '../v1/reply.mjs';
import * as base from '../v1/policy.mjs';
const tiles=[];
for(const piece of pieces)for(let start=0;start<64;start+=8){
  const make=(start,count)=>{
    const t=tile(piece,start,count);
    if(t.header.length+t.data.length>7400){make(start,count/2);make(start+count/2,count/2);return;}
    const name='row'+piece+start;
    const source=`function ${name}(a,d,square,status) {
      let start = ((square-${start})*80+d)*${t.width};
      let row = int('${t.header}'[start:start+${t.width}]);
      return '${t.data}'[row*80+a] == status[0];
    }`;
    tiles.push({piece,start,count,name,source});
  };
  make(start,8);
}
export function tableSources(){
  return {replyCapture:replySource(), ...Object.fromEntries(tiles.map(t=>[t.name,t.source]))};
}
function dispatch(group){
  if(group.length===1)return group[0].name+'(a,d,square,status)';
  const i=Math.floor(group.length/2);
  return '(square < '+group[i].start+' ? '+dispatch(group.slice(0,i))+' : '+dispatch(group.slice(i))+')';
}
function tableGuard(){
  const sel=pieces.map(k=>dispatch(tiles.filter(t=>t.piece===k)));
  return `function endingTable(text,color,square,piece,status) {
    let a = (text.split(color+'k,')[0]+'!').split(',').size()-1;
    let d = (text.split(color=='w'?'bk,':'wk,')[0]+'!').split(',').size()-1;
    return piece == color+'r' ? ${sel[0]} : piece == color+'q' ? ${sel[1]} : piece == color+'b' ? ${sel[2]} : ${sel[3]};
  }`;
}
export function compile(api,variant,options){
  if(!variant.startsWith('indexed-'))return base.compile(api,variant,options);
  const out=base.compile(api,variant.slice(8),options);
  for(const [name,source] of Object.entries(tableSources())){
    const invoke=api(source);
    if(options.mode!=='standalone')out.modules[name]=invoke.firestoreModule();
  }
  return out;
}

export async function link(modules,resolveModules,{variant}){
  if(!variant.startsWith('indexed-'))return base.link(modules,resolveModules,{variant});
  const sources=tableSources();
  const original=Object.fromEntries(Object.entries(modules).filter(([k])=>!(k in sources)));
  let rules=await base.link(original,resolveModules,{variant:variant.slice(8)});
  const anchor='return packedSafe(text, color);';
  assert.equal(rules.split(anchor).length,2);
  const regex="'[,#]*(?:[wb][kqrbn][,#]+){3}'";
  const mine="next.board[next.lastMove.to]";
  const guard="(castle || !text.matches("+regex+") || !("+mine+" in [color+'r',color+'q',color+'b',color+'n']) || endingTable(text,color,xTo+yTo*8,"+mine+",next.status))";
  const reply="(next.status == 'playing' || !replyCapture(text,color))";
  rules=rules.replace(anchor,'return packedSafe(text,color) && '+guard+' && '+reply+';').replace('  function chessMove() {',tableGuard()+'\n  function chessMove() {');
  rules=rules.replace("rules_version = '2';","rules_version = '2+modules';\n"+
    Object.keys(sources).map(n=>"import { "+n+" } from './"+n+"';").join('\n'));
  const linked=resolveModules(rules,{modules:Object.fromEntries(Object.keys(sources).map(n=>['./'+n,modules[n]])),
    sourceFile:'chess-table.modules.rules'});
  assert.ok(linked.success,linked.error?.message);
  const result=linked.data.resolved;
  assert.ok(result.trimEnd().split('\n').at(-1).startsWith('// @pyric-source-map: '));
  return result.slice(0,result.lastIndexOf('// @pyric-source-map: '));
}
