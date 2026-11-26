/** Specialize the attacking-piece checks to a target square. Only valid board keys are emitted. */
export const files = 'abcdefgh';
export const squares = Array.from({length:64}, (_, i) => files[i % 8] + (1 + Math.floor(i / 8)));
const ranksInOrder = [0,7,1,6,2,5,3,4];
const orthogonal = [[1,0],[-1,0],[0,1],[0,-1]];
const diagonal = [[1,1],[-1,-1],[1,-1],[-1,1]];
const neighbors = [...orthogonal, ...diagonal];
const knight = [[-1,-2],[1,-2],[-2,-1],[2,-1],[-2,1],[2,1],[-1,2],[1,2]];

function toSquare(x,y) {
  return x >= 0 && x < 8 && y >= 0 && y < 8 ? squares[8*y+x] : undefined;
}
const cell = sq => 'b.'+sq;
const list = xs => '['+xs.join(', ')+']';

function ray(x, y, [dx,dy]) {
  const found = [];
  for (let n=1; toSquare(x+dx*n,y+dy*n); n++) found.push(toSquare(x+dx*n,y+dy*n));
  return found;
}

export function squarePolicy(sq, {slidersOnly=false, material=false}={}) {
  const x=files.indexOf(sq[0]), y=Number(sq[1])-1;
  const nearby = steps => steps.flatMap(([dx,dy]) => toSquare(x+dx,y+dy) ?? []).map(cell);
  const lines = [
    [orthogonal,'rookQueen'],
    [diagonal,'bishopQueen'],
  ];
  const tests = [];
  for (const [steps,pieces] of lines) {
    const lineTests=[];
    for (const dir of steps) {
    const cells = ray(x,y,dir).map(cell);
    if (!cells.length) continue;
    // A non-attacking sentinel makes [0] valid on an empty ray.
    const nearest = cells.length === 1 ? cells[0] : list([...cells,"'-'"])+".removeAll([''])[0]";
    lineTests.push('!('+nearest+' in '+pieces+')');
    }
    const rays=lineTests.join(' && ');
    const symbol=pieces==='rookQueen'?'r':'b';
    tests.push(material ? "(!((enemy + 'q' in material) || (enemy + '"+symbol+"' in material)) || ("+rays+'))' : rays);
  }
  if (!slidersOnly) {
    tests.push("!(enemy + 'n' in "+list(nearby(knight))+")");
    tests.push("!(enemy + 'k' in "+list(nearby(neighbors))+")");
    const pawn = dy => list(nearby([[-1,dy],[1,dy]]));
    tests.push("!(enemy + 'p' in (enemy == 'b' ? "+pawn(1)+' : '+pawn(-1)+'))');
  }
  return 'function safe'+sq+'(b, enemy'+(material?', material':'')+') {\n'
    +"  let rookQueen = [enemy + 'r', enemy + 'q'];\n"
    +"  let bishopQueen = [enemy + 'b', enemy + 'q'];\n"
    +'  return '+tests.join('\n    && ')+';\n}';
}

/** The stored board is the ordinary 64-key Arcade map. No index or safety claim is supplied. */
export function locatePolicy() {
  const ranks = ranksInOrder.map(y=>{
    const row = squares.slice(8*y,8*y+8);
    const file = row.slice(0,7).map((s,i)=>cell(s)+' == king ? '+(8*y+i)+' : ').join('')+(8*y+7);
    return 'king in '+list(row.map(cell))+' ? ('+file+') : ';
  });
  return 'function locateKing(b, king) {\n  return '+ranks.join('\n    ')+'-1;\n}';
}

export function geometricSources(variant) {
  if(!['pins','attacks','castle','optimized'].includes(variant)) throw Error('Unknown safety variant '+variant);
  return Object.fromEntries([['locateKing',locatePolicy()],...squares.map(s=>['safe'+s,squarePolicy(s,{slidersOnly:variant==='pins',material:variant==='optimized'})])]);
}

export function selectSquare(lo,hi,makeCall) {
  if (lo===hi) return makeCall(squares[lo]);
  const mid = Math.floor((lo+hi)/2);
  return '(index <= '+mid+' ? '+selectSquare(lo,mid,makeCall)+' : '+selectSquare(mid+1,hi,makeCall)+')';
}
