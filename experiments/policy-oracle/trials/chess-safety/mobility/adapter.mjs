import assert from 'node:assert/strict';
import {compile as baseCompile,link as baseLink} from '../policy/adapter.mjs';
import {groupedSources} from './grouped.mjs';
import {packedSources,attackPattern} from '../policy/packed.mjs';

const dirs=[['N',0,1],['NE',1,1],['E',1,0],['SE',1,-1],['S',0,-1],['SW',-1,-1],['W',-1,0],['NW',-1,1]];
export function moveSources(specialized=false) {
  return Object.fromEntries(dirs.flatMap(([dir,dx,dy])=>{
    const offset=dy*10+dx;
    const middle='((?:[^,]*,){'+(Math.abs(offset)-1)+'})';
    function expression(color) {
      const other=color==='w'?'b':'w';
      // A wall, friendly piece or the enemy king is outside the target alphabet.
      const target='(?:'+other+'[prnbq])?,';
      const pattern=offset>0 ? color+'k,'+middle+target : '(^|,)'+target+middle+color+'k,';
      const replacement=offset>0 ? ',$1'+color+'k,' : '$1'+color+'k,$2,';
      return "text.replace('"+pattern+"', '"+replacement+"')";
    }
    if (specialized) return ['w','b'].map(color=>{
      const name='kingReply'+color+dir;
      return [name,'function '+name+'(text) { let next = '+expression(color)+ "; return next != text && !next.matches('" + attackPattern(color) + "'); }"];
    });
    const name='kingStep'+dir;
    return [[name,'function '+name+"(text, color) { return color == 'w' ? "+expression('w')+' : '+expression('b')+'; }']];
  }));
}

export function compileMobility(compileFunction,{mode='both',specialized=false,grouped=false}={}) {
  const sources=moveSources(specialized);
  const fns=Object.fromEntries(Object.entries(sources).map(([n,s])=>[n,compileFunction(s)]));
  const pooled=grouped ? Object.fromEntries(Object.entries(groupedSources()).map(([name,src])=>[name,compileFunction(src)])) : null;
  const modules=mode==='standalone'?{}:Object.fromEntries(Object.entries(pooled??fns).map(([n,f])=>[n,f.firestoreModule()]));
  const {packNormal,packedSafe}=packedSources(true);
  const pack=compileFunction(packNormal),safe=compileFunction(packedSafe);
  function directions(board,color) {
    const text=pack(board);
    return dirs.filter(([name])=>{
      if (specialized) return fns['kingReply'+color+name](text);
      const next=fns['kingStep'+name](text,color);
      return next!==text && safe(next,color);
    }).map(([n])=>n);
  }
  function hasReply(board,color) { return pooled ? pooled['anyKingReply'+color](pack(board)) : !!directions(board,color).length; }
  return {directions,hasReply,inCheck:(board,color)=>!safe(pack(board),color),modules};
}

export function compile(compileFunction,variant='king-reply',{mode='both'}={}) {
  assert.ok(['king-reply','king-reply-v2','king-reply-v3','king-reply-v4','king-reply-v5'].includes(variant));
  const primary=baseCompile(compileFunction,'packed-v5',{mode});
  const witness=compileMobility(compileFunction,{mode,specialized:variant!=='king-reply',grouped:['king-reply-v4','king-reply-v5'].includes(variant)});
  function predict(input) {
    const {resource:old,data:next}=input;
    if(!primary.predict(input)) return false;
    const color=old.currentTurn==='host'?'b':'w';
    if (!['won','draw'].includes(next.status)) return true;
    if (variant==='king-reply-v5' && witness.inCheck(next.board,color)!==(next.status==='won')) return false;
    return !witness.hasReply(next.board,color);
  }
  return {modules:{...primary.modules,...witness.modules},predict,directions:witness.directions,hasReply:witness.hasReply};
}

export async function link(modules,resolveModules,{variant='king-reply'}={}) {
  assert.ok(['king-reply','king-reply-v2','king-reply-v3','king-reply-v4','king-reply-v5'].includes(variant));
  const specialized=variant!=='king-reply';
  const grouped=['king-reply-v4','king-reply-v5'].includes(variant);
  const names=Object.keys(grouped?groupedSources():moveSources(specialized));
  const moves=Object.fromEntries(names.map(n=>[n,modules[n]]));
  const primary=Object.fromEntries(Object.entries(modules).filter(([n])=>!names.includes(n)));
  const base=await baseLink(primary,resolveModules,{variant:'packed-v5'});
  return linkOnto(base,moves,resolveModules,{specialized,byRank:variant==='king-reply-v3',grouped,checkStatus:variant==='king-reply-v5'});
}

/** Append the positive witness after the caller's existing terminal conjunct.
 * A caller that already decided an exact material class may pass its reviewed
 * Rules guard as covered; this value is supplied at link time only. */
export function linkOnto(base,moves,resolveModules,{specialized=true,byRank=false,grouped=false,checkStatus=false,covered,fuseTerminal=false,extra=[],customReply=null}={}) {
  const names=[...(customReply?.names??Object.keys(grouped?groupedSources():moveSources(specialized))),...extra];
  assert.deepEqual(Object.keys(moves).sort(),[...names].sort());
  const imports=names.map(n=>"import { "+n+" } from './"+n+"';").join('\n');
  const libraries=Object.fromEntries(names.map(n=>['./'+n,moves[n]]));
  const byColor=color=>{
    const attempts=names=>names.map(dir=>'kingReply'+color+dir+'(text)').join(' || ');
    if(!byRank) return attempts(dirs.map(([name])=>name));
    const top=".*#,#,[^#]*"+color+"k,[^#]*#,#,";
    const bottom="[^#]*"+color+"k,[^#]*#,#,.*";
    return attempts(['E','W'])+" || (!text.matches('"+top+"') && ("+attempts(['N','NE','NW'])+")) || (!text.matches('"+bottom+"') && ("+attempts(['S','SE','SW'])+"))";
  };
  const wrapper=customReply ? customReply.wrapper : grouped ? "function hasKingReply(text,color) {return color == 'w' ? anyKingReplyw(text) : anyKingReplyb(text);}" : specialized ? "function hasKingReply(text,color) { return color == 'w' ? ("+byColor('w')+") : ("+byColor('b')+"); }" : "function validKingStep(text, nextText, color) { return text != nextText && packedSafe(nextText, color); }\n"+
    'function hasKingReply(text, color) { return '+names.map(n=>'validKingStep(text,'+n+'(text, color),color)').join(' || ')+'; }';
  const statements=base.match(/return packedSafe\(text, color\)[^;]*;/g)??[];
  assert.equal(statements.length,1,'expected one complete move king-safety return');
  const [test]=statements;
  const args="castle ? packNormal(next.board) : text, color == 'w' ? 'b' : 'w'";
  const check=checkStatus ? "validTerminalClaim("+args+",next.status)" : "!hasKingReply("+args+")";
  const gate="(!(next.status in ['won','draw']) || "+(covered?'('+covered+') || ':'')+check+")";
  const shape=checkStatus ? "function validTerminalClaim(text, color, status) { return packedSafe(text,color) == (status == 'draw') && !hasKingReply(text,color); }" : '';
  const merged=fuseTerminal ? fuseTerminal(test) : {test:test.slice(0,-1)+' && '+gate+';',helpers:shape};
  const patched=base.replace(test,merged.test);
  const start="rules_version = '2';";
  assert.equal(patched.split(start).length,2);
  const target=patched.replace(start,"rules_version = '2+modules';\n"+imports).replace('service cloud.firestore {','service cloud.firestore {\n'+wrapper+merged.helpers);
  const result=resolveModules(target,{modules:libraries,sourceFile:'king-mobility.rules'});
  assert.ok(result.success,result.error?.message);
  const source=result.data.resolved;
  assert.ok(source.trimEnd().split('\n').at(-1).startsWith('// @pyric-source-map: '));
  return source.slice(0,source.lastIndexOf('// @pyric-source-map: '));
}
