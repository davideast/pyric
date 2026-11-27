// Sufficient proof for a slider checking a king across exactly two empty diagonal squares.
import assert from 'node:assert/strict';
const tag='-dense3';
export function denseBase(variant) { return variant.endsWith(tag)?variant.slice(0,-tag.length):null; }
const piecePattern=(piece,stride,target,continuous)=>{
  const gap=stride===1?'':'.{'+(stride-1)+'}';
  const span=gap+(continuous?'(?:[,t]'+gap+')*':'');
  return [piece+span+target,target+span+piece];
};
function proof(side,boxed=false) {
  const enemy=side==='w'?'b':'w';
  // One cell per playable square, two walls per rank. Preserve all blockers.
  const conversions=[[enemy+'q,','Q'],[enemy+'b,','B'],[enemy+'[rpnk],','X'],
                     [side+'([prnbqk]),','$1'],['#,','#']];
  const compact='text'+conversions.map(([a,b])=>".replace('"+a+"','"+b+"')").join('');
  const alternatives=[];
  for(const step of [9,11]) {
    const g='(.{'+(step-1)+'})';
    alternatives.push(['k'+g+','+g+','+g+'[BQ]','k$1t$2t$3C'],
                      ['[BQ]'+g+','+g+','+g+'k','C$1t$2t$3k']);
  }
  const marked='compact'+alternatives.map(([a,b])=>".replace('"+a+"','"+b+"')").join('');
  const reach=[
    ...[1,10].flatMap(stride=>piecePattern('[rq]',stride,'[tC]',true)),
    ...[9,11].flatMap(stride=>piecePattern('[bq]',stride,'[tC]',true)),
    ...[8,12,19,21].flatMap(stride=>piecePattern('n',stride,'[tC]',false))
  ];
  for(const stride of [9,11]) {
    const gap='.{'+(stride-1)+'}';
    reach.push(side==='w'?'p'+gap+'C':'C'+gap+'p');
  }
  // Counting a two-square pawn push even off its home rank is conservative.
  // Promoting does not change the set of reachable destination squares.
  reach.push(...(side==='w'?['p.{9}t','p.{9}[,t].{9}t']:['t.{9}p','t.{9}[,t].{9}p']));
  if(boxed) {
    // Every marked empty target stays attacked by the same checking slider
    // after a king step onto it. Any other vacant or enemy neighbor is a
    // possible escape, so defer to the ordinary policy even if it is attacked.
    for(const stride of [1,9,10,11]) reach.push(...piecePattern('k',stride,'[,BQXC]',false));
  }
  const name=(boxed?'denseBoxedMate':'denseNoInterposition')+side;
  return [name,`function ${name}(text) {
  let compact=${compact};
  let marked=${marked};
  return marked!=compact && !marked.matches('.*(?:${reach.join('|')}).*');
}`];
}
export function denseSources(boxed=false) { return Object.fromEntries(['w','b'].map(side=>proof(side,boxed))); }
export function denseLink(full,extra,boxed=false) {
  const marker='  function admittedStatus(';
  assert.equal(full.split(marker).length,2);
  const names=Object.keys(denseSources(boxed));
  const functions=names.map(name=>extra[name].replace(/^rules_version\s*=\s*'2\+modules';\s*export /,'').trim());
  const gate=boxed?`function denseSliderStatus(text,color,status) {
    return (color=='w' ? text.matches('.*bp,.*bp,.*') && denseBoxedMateb(text)
                       : text.matches('.*wp,.*wp,.*') && denseBoxedMatew(text))
        ? status=='won' : admittedStatus(text,color,status);
  }`:`function denseSliderStatus(text,color,status) {
    let defender=color=='w'?'b':'w';
    return (color=='w'? text.matches('.*bp,.*bp,.*') && denseNoInterpositionb(text)
                      : text.matches('.*wp,.*wp,.*') && denseNoInterpositionw(text))
      ? status!='draw' && ((status=='playing')==hasKingReply(text,defender))
      : admittedStatus(text,color,status);
  }`;
  full=full.replace(marker,()=>functions.join('\n  ')+'\n  '+gate+'\n'+marker);
  // This normal slider route explicitly verifies next.enPassant==''.
  const call='sliderTravel(text,piece[1:2],x,y,xt,yt) && packedSafe(text,color) && admittedStatus(text,color,next.status)';
  assert.equal(full.split(call).length,2);
  return full.replace(call,()=>call.replace('admittedStatus','denseSliderStatus'));
}
