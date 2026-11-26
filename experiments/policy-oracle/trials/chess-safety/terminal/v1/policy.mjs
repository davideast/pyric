import assert from 'node:assert/strict';
import {groups,squares} from './geometry.mjs';
import {compactSources,installCompact} from './compact.mjs';
import * as base from '../../policy/adapter.mjs';

// Specialize the eight legal king responses by the square occupied by the slider.
// The groups are calculated from piece geometry, without reading any oracle fixture.
const positions=groups();
function family(square,queen) {
  const rows=positions.filter(r=>r.slider===square&&r.queen===queen);
  return rows.map(r=>{
    const mine=r.attackers.length===1?'board.'+r.attackers[0]+' == mine':
      'mine in ['+r.attackers.map(s=>'board.'+s).join(', ')+']';
    return '(board.'+r.defender+' == theirs && ('+mine+")) ? '"+r.status+"' : ";
  }).join('')+"'playing'";
}
function source(sq) {
  return 'function ending'+sq+'(board, mine, theirs, queen) { return queen ? ('+
    family(sq,true)+') : ('+family(sq,false)+'); }';
}
const name=sq=>'ending'+sq;
export function compile(compileFunction,variant,options) {
  if(variant.startsWith('table-')) {
    const p=base.compile(compileFunction,variant.slice(6),options);
    for(const [key,source] of Object.entries(compactSources())){
      const invoke=compileFunction(source);
      if(options.mode!=='standalone')p.modules[key]=invoke.firestoreModule();
    }
    return p;
  }
  if(!variant.startsWith('ending-')) return base.compile(compileFunction,variant,options);
  const primary=base.compile(compileFunction,variant.slice(7),options);
  const functions=Object.fromEntries(squares.map(s=>[s,compileFunction(source(s))]));
  if(options.mode!=='standalone') {
    for(const sq of squares)primary.modules[name(sq)]=functions[sq].firestoreModule();
  }
  return primary;
}

function select(lo,hi) {
  if(lo===hi)return name(squares[lo])+'(board, mine, theirs, queen)';
  const mid=(lo+hi)>>1;
  return '(index <= '+mid+' ? '+select(lo,mid)+' : '+select(mid+1,hi)+')';
}
export async function link(modules,resolveModules,{variant}) {
  if(variant.startsWith('table-')){
    const names=new Set(Object.keys(compactSources()));
    const originals=Object.fromEntries(Object.entries(modules).filter(([k])=>!names.has(k)));
    let rules=await base.link(originals,resolveModules,{variant:variant.slice(6)});
    rules=installCompact(rules).replace("rules_version = '2';","rules_version = '2+modules';\n"+
      [...names].map(n=>"import { "+n+" } from './"+n+"';").join('\n'));
    const result=resolveModules(rules,{modules:Object.fromEntries([...names].map(n=>['./'+n,modules[n]])),sourceFile:'chess-endings.modules.rules'});
    assert.ok(result.success,result.error?.message);
    return result.data.resolved.slice(0,result.data.resolved.lastIndexOf('// @pyric-source-map: '));
  }
  if(!variant.startsWith('ending-')) return base.link(modules,resolveModules,{variant});
  const ends=new Set(squares.map(name));
  const originals=Object.fromEntries(Object.entries(modules).filter(([key])=>!ends.has(key)));
  let rules=await base.link(originals,resolveModules,{variant:variant.slice(7)});
  assert.equal(rules.split("rules_version = '2';").length,2);
  const imports=squares.map(s=>"import { "+name(s)+" } from './"+name(s)+"';").join('\n');
  rules=rules.replace("rules_version = '2';","rules_version = '2+modules';\n"+imports);
  const point="{'a':0,'b':1,'c':2,'d':3,'e':4,'f':5,'g':6,'h':7}[square[0:1]]";
  const actual=`function endingClaim(board, square, color, status) {
    let mine = color + 'k';
    let theirs = color == 'w' ? 'bk' : 'wk';
    let queen = board[square] == color + 'q';
    let index = ${point} + (int(square[1:2])-1)*8;
    return status == ${select(0,63)};
  }`;
  const marker='  function chessMove() {';
  const guard='boardTransition(old, next, mv, piece, color)';
  assert.equal(rules.split(marker).length,2);
  const i=rules.indexOf(marker), before=rules.slice(0,i), after=rules.slice(i);
  assert.equal(after.split(guard).length,2);
  const terminal="(!(next.board[mv.to] in [color + 'q', color + 'r']) || next.board.values().removeAll(['']).size() != 3 || endingClaim(next.board, mv.to, color, next.status))";
  rules=before+actual+'\n'+after.replace(guard,guard+' && '+terminal);
  const app=Object.fromEntries(squares.map(s=>['./'+name(s),modules[name(s)]]));
  const bundled=resolveModules(rules,{modules:app,sourceFile:'chess-endings.modules.rules'});
  assert.ok(bundled.success,bundled.error?.message);
  const result=bundled.data.resolved;
  assert.ok(result.trimEnd().split('\n').at(-1).startsWith('// @pyric-source-map: '));
  return result.slice(0,result.lastIndexOf('// @pyric-source-map: '));
}
