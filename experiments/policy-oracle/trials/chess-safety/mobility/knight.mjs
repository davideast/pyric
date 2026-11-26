import assert from 'node:assert/strict';
import * as base from '../pawns/v1/adapter.mjs';
import {packedSources,attackPattern} from '../policy/packed.mjs';
import {squares} from '../policy/geometry.mjs';
import {pairSources,pairHelper,pairStandalone} from './knight-pairs.mjs';
import {specializeAdmission} from './knight-budget.mjs';

const leaps=[8,12,19,21,-8,-12,-19,-21];
const starts=variant=>variant.startsWith('knight-');
const parent=variant=>variant.replace(/^knight-(?:quiet-|pair-|all-|budget-|endgame-)?/,'');

function projection(color,offset,first) {
  const enemy=color==='w'?'b':'w', knight=color+'n,',target='(?:'+enemy+'[prnbq])?,';
  const gap='((?:[^,]*,){'+(Math.abs(offset)-1)+'})';
  const leading=first?'*?':'*';
  // The negative offset's leading capture stops on a token boundary, so an
  // occupied destination cannot be mistaken for its trailing comma.
  const expr=offset>0?'^X(.'+leading+')'+knight+gap+target+'(.*)$'
    : '^X((?:[^,]*,)'+leading+')'+target+gap+knight+'(.*)$';
  const move=offset>0?'$1,$2'+knight+'$3':'$1'+knight+'$2,$3';
  return "original.replace('"+expr+"','"+move+"')";
}

function quietSource(color) {
  const enemy=color==='w'?'b':'w';
  const skip=n=>n?'(?:[^,]*,){'+n+'}':'';
  const target='(?:'+enemy+'[prnbq])?,',n=color+'n,',k=color+'k,';
  const jumps=leaps.map(offset=>offset>0?n+skip(offset-1)+target:target+skip(-offset-1)+n);
  const movable='(?:[^,]*,)*(?:'+jumps.join('|')+').*';
  const rays=[];
  for(const stride of [1,9,10,11]) {
    const between=skip(stride-1)+'(?:,'+skip(stride-1)+')*';
    const pinner=enemy+(stride===1||stride===10?'[rq],':'[bq],');
    rays.push(k+between+n+between+pinner,pinner+between+n+between+k);
  }
  // A knight cannot land on its own pin line or capture the collinear pinner.
  // With a safe king, any pseudo-legal move by an unpinned knight stays safe:
  // the destination remains occupied after a capture.
  return `function quietKnight${color}(text) {
    return !text.matches('${movable}') ? 0 : !text.matches('.*(?:${rays.join('|')}).*') ? 1
          : text.matches('.*${n}.*${n}.*') ? 2 : 0;
  }`;
}

export function knightSources(quiet=false){
  const sources={};
  for(const color of ['w','b'])for(const first of [false,true]){
    const name='knight'+color+(first?'First':'Last');
    const candidates=leaps.map(offset=>projection(color,offset,first));
    const attacked=attackPattern(color).replaceAll('.*','[^;]*').replaceAll('[^,]','[^,;]');
    const allFailed='(?:(?:X[^;]*|'+attacked+');){8}';
    sources[name]=`function ${name}(text) {
      let original='X'+text;
      let candidates=[${candidates.join(',')}].join(';')+';';
      return !candidates.matches('${allFailed}'); }`;
  }
  if(quiet)for(const color of ['w','b'])sources['quietKnight'+color]=quietSource(color);
  return sources;
}
export function compileKnight(api,{mode='both',quiet=false,pair=false,all=false}={}) {
  const {packNormal,packedSafe}=packedSources(true);
  const pack=api(packNormal),safe=api(packedSafe);
  const paired=pair?pairStandalone(api,all):null;
  const compiled=paired?.compiled??Object.fromEntries(Object.entries(knightSources(quiet)).map(([key,src])=>[key,api(src)]));
  const modules=mode==='standalone'?{}:Object.fromEntries(Object.entries(compiled).map(([key,fn])=>[key,fn.firestoreModule()]));
  const projects=new Map();
  for(const color of ['w','b'])for(const first of [false,true])for(const offset of leaps) {
    projects.set([color,first,offset].join(':'),api('function project(original) { return '+projection(color,offset,first)+'; }'));
  }
  function witnesses(board,color) {
    const text=pack(board),moves=new Set();
    const layers=paired?.layers(text,color)??[text];
    for(const layer of layers) {
      const input='X'+layer,original=layer.split(',');
      for(const first of [false,true])for(const offset of leaps) {
        const proposed=projects.get([color,first,offset].join(':'))(input);
        if(proposed===input || !safe(proposed,color))continue;
        const tokens=proposed.split(',');
        const changed=squares.filter((square,i)=>{
          const padded=i+2*Math.floor(i/8);
          return tokens[padded]!==original[padded];
        });
        assert.equal(changed.length,2);
        const from=changed.find(sq=>board[sq]===color+'n');
        const to=changed.find(sq=>sq!==from);
        assert.ok(from&&to);
        moves.add(from+to);
      }
    }
    return [...moves].sort();
  }
  function hasReply(board,color) {
    const text=pack(board);
    if(!Object.values(board).includes(color+'k'))return false;
    if(paired)return paired.hasReply(text,color);
    if(quiet && safe(text,color)) {
      const answer=Number(compiled['quietKnight'+color](text));
      if(answer!==2)return answer===1;
    }
    const count=Object.values(board).filter(p=>p===color+'n').length;
    return count>0 && (compiled['knight'+color+'Last'](text) || (count>1 && compiled['knight'+color+'First'](text)));
  }
  return {modules,witnesses,hasReply};
}

export function compile(api,variant,options={mode:'both'}) {
  if(!starts(variant))return base.compile(api,variant,options);
  const out=base.compile(api,parent(variant),options);
  const all=(variant.startsWith('knight-all-')||/^knight-(?:budget|endgame)-/.test(variant)),pair=all||variant.startsWith('knight-pair-');
  const knights=compileKnight(api,{...options,quiet:variant.startsWith('knight-quiet-'),pair,all});
  Object.assign(out.modules,knights.modules);
  out.knightMoves=knights.witnesses;
  out.hasKnightReply=knights.hasReply;
  return out;
}

export function linkOnto(rules,modules,resolveModules,{quiet=false,pair=false,all=false}={}) {
  const names=Object.keys(pair?pairSources(all):knightSources(quiet));
  assert.deepEqual(Object.keys(modules).sort(),[...names].sort());
  const bound=rules.match(/  function admittedStatus\(text, color, status\) \{[\s\S]*?\n  \}/g);
  assert.equal(bound?.length,1);
  assert.ok(bound[0].includes('!hasKingReply(text, defender)'));
  const terminalEnd=bound[0].lastIndexOf(';');
  const checked=bound[0].slice(0,terminalEnd)+(quiet?' && !knightClaimWitness(text,defender,status)':' && !knightWitness(text,defender)')+bound[0].slice(terminalEnd);
  const witness=pair ? pairHelper(all) : `function knightWitness(text,color) {
    return color=='w' ? (text.matches('.*wn,.*') && (knightwLast(text) || (text.matches('.*wn,.*wn,.*') && knightwFirst(text))))
                      : (text.matches('.*bn,.*') && (knightbLast(text) || (text.matches('.*bn,.*bn,.*') && knightbFirst(text))));
  }`;
  const shortcut=quiet?`function quietKnightWitness(text,color) {
    let answer = color=='w' ? quietKnightw(text) : quietKnightb(text);
    return answer==1 || (answer==2 && knightWitness(text,color));
  }
  function knightClaimWitness(text,color,status) {
    return status=='draw' ? quietKnightWitness(text,color) : knightWitness(text,color);
  }`:'';
  const full=rules.replace(bound[0],checked+'\n'+witness+shortcut).replace("rules_version = '2';","rules_version = '2+modules';\n"+
    names.map(n=>"import { "+n+" } from './"+n+"';").join('\n'));
  const r=resolveModules(full,{modules:Object.fromEntries(names.map(n=>['./'+n,modules[n]])), sourceFile:'knight-reply.modules.rules'});
  assert.ok(r.success,r.error?.message);
  const result=r.data.resolved;
  assert.ok(result.trimEnd().split('\n').at(-1).startsWith('// @pyric-source-map: '));
  return result.slice(0,result.lastIndexOf('// @pyric-source-map: '));
}
export async function link(modules,resolveModules,{variant}) {
  if(!starts(variant))return base.link(modules,resolveModules,{variant});
  const quiet=variant.startsWith('knight-quiet-');
  const all=(variant.startsWith('knight-all-')||/^knight-(?:budget|endgame)-/.test(variant)),pair=all||variant.startsWith('knight-pair-');
  const names=new Set(Object.keys(pair?pairSources(all):knightSources(quiet)));
  const original=Object.fromEntries(Object.entries(modules).filter(([key])=>!names.has(key)));
  const extra=Object.fromEntries(Object.entries(modules).filter(([key])=>names.has(key)));
  const rules=await base.link(original,resolveModules,{variant:parent(variant)});
  const linked=linkOnto(rules,extra,resolveModules,{quiet,pair,all});
  return /^knight-(?:budget|endgame)-/.test(variant) ? specializeAdmission(linked,{pawnPriority:variant.startsWith('knight-endgame-')}) : linked;
}
