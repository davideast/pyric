import {gap, attacks} from './sources.mjs';

// The four axes are integer lines a*x+b*y=c. A reply by the sole slider
// follows one of the canonical vectors. Signed distance covers both rays.
const axes=[
  {name:'Rank',a:0,b:1,stride:1,checkers:'[rq]'},
  {name:'File',a:1,b:0,stride:10,checkers:'[rq]'},
  {name:'Rise',a:-1,b:1,stride:11,checkers:'[bq]'},
  {name:'Fall',a:1,b:1,stride:9,checkers:'[bq]'},
];
const vectors=[
  {x:1,y:0,stride:1}, {x:0,y:1,stride:10},
  {x:1,y:1,stride:11}, {x:-1,y:1,stride:9}
];

function vectorSet(kind) {
  return kind==='r'?vectors.slice(0,2):kind==='b'?vectors.slice(2):vectors;
}

function between(stride,steps) {
  const skip=gap(stride-1);
  return skip+(steps>1?'(?:,'+skip+'){'+(steps-1)+'}':'');
}

function move(cells,span,positive,target="[,prnbq]") {
  return positive
    ? cells+".replace('S('+"+span+"+')"+target+"', ',$1X')"
    : cells+".replace('"+target+"('+"+span+"+')S', 'X$1,')";
}

function literal(s) { return "'"+s+"'"; }

function firstCapture(vector,positive) {
  const skip=gap(vector.stride-1);
  return move('board',literal(skip+'(?:,'+skip+')*'),positive,'[prnbq]');
}

function distance(axis) {
  if(axis.name==='Rank')return 'ky - sy';
  if(axis.name==='File')return 'kx - sx';
  if(axis.name==='Rise')return '(ky - sy) - (kx - sx)';
  return '(ky - sy) + (kx - sx)';
}

const prelude=`let origin = board.replace('S.*','').size();
  let king = board.replace('K.*','').size();`;
const vectorName=vector=>'span'+vector.stride;

function classify(color) {
  // Both a failed projection (S remains) and an attacked successor are removed.
  // The front remaining record is a real post-reply board, including captures.
  const rejected='[^;]*(?:S|'+attacks(color)+')[^;]*;';
  return `let first = (candidates+';').replace('${rejected}', '').split(';')[0];
  return first=='' ? -1 : origin*80 + first.replace('X.*','').size();`;
}

function axisSource(kind,axis,color,compact) {
  const lines=[];
  lines.push(prelude);
  const dx=axis.a!==0,dy=axis.b!==0;
  if(dx)lines.push('let kx = king % 10;','let sx = origin % 10;');
  if(dy)lines.push('let ky = king / 10;','let sy = origin / 10;');
  lines.push('let d = '+distance(axis)+';');
  const crossings=[],collinear=[];
  // Helpers stay under Firestore's ten-let ceiling by preparing each span table
  // in the expression that needs it. No coordinate or move is provided by the client.
  for (const v of vectorSet(kind)) {
    const denominator=axis.a*v.x+axis.b*v.y;
    if(!denominator){collinear.push(firstCapture(v,true),firstCapture(v,false));continue;}
    const n=denominator<0?'(-d)':'d';
    const length=Math.abs(denominator)===2?'('+n+' / 2)':n;
    const spans=Array.from({length:8},(_,i)=>between(v.stride,i));
    const spanTable=compact?literal(spans.join('~'))+".split('~')":'['+spans.map(literal).join(',')+']';
    const index='('+length+' > 0 ? '+length+' : -'+length+')';
    const span=spanTable+'['+index+']';
    const positive=move('board',span,true),negative=move('board',span,false);
    const invalid=[];
    if(Math.abs(denominator)===2)invalid.push('d % 2 != 0');
    if(axis.a&&axis.b&&Math.abs(denominator)===1)invalid.push('d > 7','d < -7');
    const guard=invalid.length?invalid.join(' || ')+' ? board : ':'';
    crossings.push('('+guard+length+' > 0 ? '+positive+' : '+negative+')');
  }
  const boards=xs=>xs.length===0?"board":xs.length===1?xs[0]:'['+xs.join(',\n    ')+'].join(\';\')';
  lines.push('let candidates = d==0 ? '+boards(collinear)+' : '+boards(crossings)+';');
  lines.push(classify(color));
  const name='slide'+kind+axis.name+color;
  return {name,source:'function '+name+'(board) {\n  '+lines.join('\n  ')+'\n}'};
}

function quietSource(kind,color,inCheck) {
  const options=[];
  for(const v of vectorSet(kind))for(const positive of [true,false]) {
    options.push(inCheck?firstCapture(v,positive):move('board',literal(gap(v.stride-1)),positive));
  }
  const name='slide'+kind+(inCheck?'Capture':'Step')+color;
  return {name,source:`function ${name}(board) {
  let origin = board.replace('S.*','').size();
  let candidates = [${options.join(',\n    ')}].join(';');
  ${classify(color)}
}`};
}

function lineDanger(axis) {
  const skip=gap(axis.stride-1);
  const path=skip+'(?:,'+skip+')*';
  return '.*(?:K'+path+axis.checkers+'|'+axis.checkers+path+'K).*';
}

export function crossSources(variant) {
  const kinds = variant === 'rook-cross-v2' ? 'r' : variant === 'bishop-cross-v3' ? 'rb' : 'rbq';
  const out={};
  for(const color of ['w','b']) {
    const name='slideCheck'+color;
    const axisTests=axes.map((axis,i)=>"board.matches('"+lineDanger(axis)+"') ? "+(i+1)+" : ");
    out[name]='function '+name+"(board) { return "+axisTests.join('')+"board.matches('.*"+attacks(color)+".*') ? 5 : 0; }";
    for(const kind of kinds){
      const functions=axes.map(axis=>axisSource(kind,axis,color,variant!=='rook-cross-v2'));
      functions.push(quietSource(kind,color,false),quietSource(kind,color,true));
      for(const fn of functions)out[fn.name]=fn.source;
    }
  }
  return out;
}

export function crossBinding() {
  const functions=[];
  for(const color of ['w','b']) {
    const choose=axes.map((axis,i)=>'direction == '+(i+1)+' ? slider'+axis.name+color+'(board) : ').join('');
    functions.push(`function sliderChoice${color}(board) {
    let direction = slideCheck${color}(board);
    return ${choose}direction == 0 ? sliderStep${color}(board) : sliderCapture${color}(board);
  }`);
  }
  functions.push(`function sliderMove(text,defender) {
    return defender == 'w' ? sliderChoicew(sliderEncodew(text)) : sliderChoiceb(sliderEncodeb(text));
  }`);
  functions.push(`function sliderStatus(text,defender,status) {
    return status == 'playing' ? (hasKingReply(text,defender) || sliderMove(text,defender)>=0)
      : packedSafe(text,defender)==(status=='draw') && !hasKingReply(text,defender) && sliderMove(text,defender)<0;
  }`);
  return functions.join('\n  ');
}

export function familyRoute(kind,color) {
  const stem = 'slide'+kind;
  const choose=axes.map((axis,i)=>'direction == '+(i+1)+' ? '+stem+axis.name+color+'(board) : ').join('');
  return choose+'direction == 0 ? '+stem+'Step'+color+'(board) : '+stem+'Capture'+color+'(board)';
}
