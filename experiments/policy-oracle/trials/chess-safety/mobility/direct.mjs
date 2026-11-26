/** Attack on an adjacent destination using the original packed board as the input.
 * Offset 0 is the defending king, which vacates its current square. The destination
 * may previously hold a capturable enemy. All intervening ray squares must be
 * empty except for the original king itself. The real source board is unchanged. */
export const directions=[['N',10],['NE',11],['E',1],['SE',-9],['S',-10],['SW',-11],['W',-1],['NW',9]];
const prefix='(?:[^,]*,)*',any='(?:[^,]*,)';
const gap=n=>!n?'':n===1?any:any+'{'+n+'}';
const choice=list=>list.length===1?list[0]:'(?:'+list.join('|')+')';
function ordered(cells,skip=gap) {
  const items=[...cells.entries()].sort((a,b)=>a[0]-b[0]);
  return items.flatMap(([i,v],p)=>[skip(p?i-items[p-1][0]-1:0),v]).filter(Boolean);
}
function alternation(rows) {
  const branches=new Map();
  for(const [next,...rest] of rows) {
    if(!branches.has(next))branches.set(next,[]);
    branches.get(next).push(rest);
  }
  if(branches.has(undefined))return '';
  const suffixes=new Map();
  for(const [next,remaining] of branches){
    const tail=alternation(remaining);
    if(!suffixes.has(tail))suffixes.set(tail,[]);
    suffixes.get(tail).push(next);
  }
  return choice([...suffixes].map(([suffix,items])=>choice(items)+suffix));
}

export function directTests(color,offset,compact=false) {
  const enemy=color==='w'?'b':'w',king=compact?'K':color+'k,';
  const skip=compact?(n=>!n?'':n===1?'[^;]':'[^;]{'+n+'}'):gap;
  const head=compact?'[^;]*':prefix, tail=compact?'[^;]*':'.*';
  const target=compact?'[_prnbq]':'(?:'+enemy+'[prnbq])?,';
  const valid=head+ordered(new Map([[0,king],[offset,target]]),skip).join('')+tail;
  const threats=[];
  function add(delta,piece,ray=0,distance=1) {
    const relative=offset+delta;
    if(relative===0)return;
    const cells=new Map([[0,king],[relative,compact?piece:enemy+piece+',']]);
    for(let t=1;t<distance;t++) {
      const intermediate=offset+t*ray;
      if(intermediate!==0)cells.set(intermediate,compact?'_':',');
    }
    threats.push(ordered(cells,skip));
  }
  for(const stride of [-11,-10,-9,-1,1,9,10,11]) {
    add(stride,'k');
    const kinds=Math.abs(stride)===1||Math.abs(stride)===10?'[rq]':'[bq]';
    for(let d=1;d<=7;d++)add(d*stride,kinds,stride,d);
  }
  for(const stride of [-21,-19,-12,-8,8,12,19,21])add(stride,'n');
  for(const stride of [9,11])add(color==='w'?stride:-stride,'p');
  // A missing target can lie beyond either end of the padded string, on a
  // wall, on a friendly piece, or on the enemy king. Any other token is a
  // legal geometric destination. Missing kings also decline every direction.
  const bad=compact?'[#XKk]':'(?:#|'+color+'[prnbqk]|'+enemy+'k),';
  const tooShort=(compact?'[^;]':'(?:[^,]*,)')+'{0,'+(Math.abs(offset)-1)+'}';
  const beyond=offset>0?tail+king+tooShort:tooShort+king+tail;
  const absent=compact?'[^;K]*':'(?:[,#]|[wb][prnbq],|'+enemy+'k,)*';
  const blocked=ordered(new Map([[0,king],[offset,bad]]),skip);
  const failure=compact?choice([...threats,blocked].map(parts=>parts.join(''))):alternation([...threats,blocked]);
  const rejected=choice([beyond,absent,head+failure+tail]);
  return {valid,attacked:head+alternation(threats)+tail,rejected};
}
export function directSources() {
  const out={};
  for(const color of ['w','b'])for(const [dir,offset] of directions) {
    const {valid,attacked}=directTests(color,offset);
    const name='direct'+color+dir;
    out[name]="function "+name+"(text) { return text.matches('"+valid+"') && !text.matches('"+attacked+"'); }";
  }
  return out;
}

export function directWrapper() {
  const any=color=>directions.map(([name])=>'direct'+color+name+'(text)').join(' || ');
  return "function hasKingReply(text,color) { return color == 'w' ? ("+any('w')+") : ("+any('b')+"); }";
}
export function compileDirect(compileFunction,{mode},packSource,safeSource,grouped=false,width=4,compact=false) {
  const pack=compileFunction(packSource),safe=compileFunction(safeSource);
  const functions=Object.fromEntries(Object.entries(directSources()).map(([name,s])=>[name,compileFunction(s)]));
  const groupedFns=grouped?Object.fromEntries(Object.entries(directGroupedSources(width,compact)).map(([n,s])=>[n,compileFunction(s)])):null;
  const modules=mode==='standalone'?{}:Object.fromEntries(Object.entries(groupedFns??functions).map(([name,f])=>[name,f.firestoreModule()]));
  return {
    modules,
    directions(board,color){const text=pack(board);return directions.filter(([name])=>functions['direct'+color+name](text)).map(([name])=>name);},
    hasReply(board,color){
      const text=pack(board);
      if(!groupedFns)return directions.some(([name])=>functions['direct'+color+name](text));
      const normalized=compact?groupedFns['encode'+color](text):text;
      const records=(normalized+';').repeat(width);
      return Array.from({length:directions.length/width},(_,i)=>groupedFns['allRefused'+color+i])
        .some(f=>!f(records));
    },
    inCheck(board,color){return !safe(pack(board),color);},
  };
}

// Each semicolon-delimited copy of the same unchanged board supplies one
// directional predicate. Four failed directions fit in one authorable module;
// their conjunction across both groups rules out every adjacent king step.
export function directGroupedSources(width=4,compact=false) {
  const out={};
  if(compact)for(const color of ['w','b']) {
    const enemy=color==='w'?'b':'w';
    // Every original token (including its delimiter) becomes one square.
    // Friendly nonkings are equivalent as blockers; enemy kinds retain their attacks.
    out['encode'+color]=`function encode${color}(text) { return text.replace('${color}k,','K').replace('${color}[prnbq],','X').replace('${enemy}([prnbqk]),','$1').replace('#,','#').replace(',','_'); }`;
  }
  for(const color of ['w','b']) for(let batch=0;batch<directions.length/width;batch++) {
    const name='allRefused'+color+batch;
    const test=directions.slice(width*batch,width*(batch+1)).map(([,offset])=>{
      const r=directTests(color,offset,compact).rejected.replaceAll('.*','[^;]*').replaceAll('[^,]','[^,;]');
      return r+';';
    }).join('');
    out[name]="function "+name+"(records) { return records.matches('"+test+"'); }";
  }
  return out;
}
export function directGroupedWrapper(width=4,compact=false) {
  if(compact) {
    const invalid=color=>Array.from({length:directions.length/width},(_,i)=>'allRefused'+color+i+'(records)').join(' && ');
    const repeat=Array.from({length:width},()=>"fixed+';'").join('+');
    return `function hasKingReply(text,color) {
      let fixed=color=='w'?encodew(text):encodeb(text);
      let records=${repeat};
      return color=='w' ? !(${invalid('w')}) : !(${invalid('b')});
    }`;
  }
  if(width===2) {
    const invalid=color=>Array.from({length:4},(_,i)=>'allRefused'+color+i+'(records)').join(' && ');
    return `function hasKingReply(text,color) {
      let records = text+';'+text+';';
      return color=='w' ? !(${invalid('w')}) : !(${invalid('b')});
    }`;
  }
  return `function hasKingReply(text,color) {
    let part=text+';'+text+';';
    let records=part+part;
    return color=='w' ? !(allRefusedw0(records) && allRefusedw1(records))
                      : !(allRefusedb0(records) && allRefusedb1(records));
  }`;
}
