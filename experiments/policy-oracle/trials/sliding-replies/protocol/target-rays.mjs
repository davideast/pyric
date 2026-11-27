// Mark the cells between king and checker. Project at most one move per ray,
// then run king safety on each resulting board with the original checker restored.
import assert from 'node:assert/strict';
import {sharedSources} from '../compiler/shared.mjs';
export function targetSources() {
  const source=sharedSources('all-projected-king-v11');
  for(const key of Object.keys(source)) if(/^slide[rbq](Rank|File|Rise|Fall|Capture|Step)$/.test(key)) delete source[key];
  source.targetRayMask=`function targetRayMask(board,direction) {
    let gap=direction==1 ? '' : direction==2 ? '.{9}' : direction==3 ? '.{10}' : '.{8}';
    let ray='('+gap+'(?:,'+gap+')*)';
    let attacker=direction<=2?'([rq])':'([bq])';
    let upper=board.matches('.*K'+ray+attacker+'.*');
    let check=upper?'K'+ray+attacker:attacker+ray+'K';
    let original=board.replace('.*'+check+'.*',upper?'$2':'$1');
    let marked=board.replace(check,upper?'K$1C':'C$2K');
    let step=upper?',('+gap+')([tC])':'([tC])('+gap+'),';
    let ink=upper?'t$1$2':'$1$2t';
    return [marked${'.replace(step,ink)'.repeat(6)},original];
  }`;
  const directions=[1,10,11,9];
  const lets=directions.map(stride=>{
    const between=stride===1?'':'.{'+(stride-1)+'}';
    return "let span"+stride+"=mode==0 ? '"+between+"' : '"+between+"(?:,"+between+")*';";
  });
  function group(strides) {
    const expr=strides.flatMap(stride=>[
      "board.replace('S('+span"+stride+"+')'+target,',$1X')",
      "board.replace(target+'('+span"+stride+"+')S','X$1,')",
    ]);
    return "["+expr.join(',')+"].join(';')+';'";
  }
  source.targetRayCandidates=`function targetRayCandidates(board,kind,mode) {
    let target=mode==0?'[,prnbq]':mode==1?'[tC]':'[prnbq]';
    ${lets.join('\n    ')}
    return (kind=='b'?'':${group([1,10])})+(kind=='r'?'':${group([11,9])});
  }`;
  source.targetRayFinish=`function targetRayFinish(records,rejected,checker,original) {
    let first=records.replace('t',',').replace('C',checker).replace(rejected,'').split(';')[0];
    return first==''?-1:original.replace('S.*','').size()*80+first.replace('X.*','').size();
  }`;
  return source;
}

export function targetLink(full) {
  for(const name of ['slideChooser','slideChooseb','slideChooseq','slideRooks','slideTypedw','slideTypedb']) {
    const regex=new RegExp('  function '+name+'\\([^)]*\\) \\{[^{}]*\\}\\n');
    assert.ok(regex.test(full),name);
    full=full.replace(regex,'');
  }
  const functions=[`function targetRayOne(board,kind,direction,rejected) {
    let sealed=direction>0 && direction<5 ? targetRayMask(board,direction) : [board,''];
    return targetRayFinish(targetRayCandidates(sealed[0],kind,direction==0?0:direction==5?2:1),rejected,sealed[1],board);
  }`,`function targetRayBoth(board,kind,direction,rejected) {
    let paired=board.matches('.*S.*S.*');
    let first=targetRayOne(paired?board.replace('S([^S]*)$','O$1'):board,kind,direction,rejected);
    return first>=0 || !paired ? first : targetRayOne(board.replace('^([^S]*)S','$1O'),kind,direction,rejected);
  }`];
  for(const side of ['w','b']) {
    functions.push(`function slideTyped${side}(text,board,direction) {
      let kind=text.matches('.*${side}q,.*')?'q':text.matches('.*${side}b,.*')?'b':'r';
      return board.matches('.*S.*')?targetRayBoth(board,kind,direction,slideFailurePattern(${side==='w'})):-1;
    }`);
  }
  const marker='  function slideStatusw(';
  assert.equal(full.split(marker).length,2);
  return full.replace(marker,()=>functions.join('\n  ')+'\n'+marker);
}
