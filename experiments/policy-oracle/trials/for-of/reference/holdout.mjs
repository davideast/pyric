import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { attacked, squareOf, squareName } from '../../chess/reference/arcade-reference.ts';

const sha = b => createHash('sha256').update(b).digest('hex');
const pinned = new URL('../../chess/reference/arcade-reference.ts', import.meta.url);
assert.equal(sha(readFileSync(pinned)), '1f321bbb70128936c00283d22cfe03ad84b8907a00f0dacf3363b694d6534d5e');
const files = 'abcdefgh';
const square = (x,y) => files[x]+(y+1);
const on = (x,y) => x>=0 && x<8 && y>=0 && y<8;
const directions = [[0,1],[1,0],[0,-1],[-1,0],[1,1],[-1,1],[-1,-1],[1,-1]];

export function generate(seed) {
  const rows = [];
  let draw=0;
  const choose = a => {
    const index = createHash('sha256').update(seed+':'+draw++).digest().readUInt32BE() % a.length;
    return a[index];
  };
  for (const [sx,sy] of directions) for (let d=1;d<=7;d++) {
    const starts=[];
    for (let x=0;x<8;x++) for(let y=0;y<8;y++) if(on(x+sx*d,y+sy*d)) starts.push([x,y]);
    const variations=['clear','occupied-destination'];
    if(d>1) variations.push('first-blocker','last-blocker','random-blocker');
    for (const variation of variations) {
      const [x,y]=choose(starts), dx=sx*d, dy=sy*d;
      const from=square(x,y),to=square(x+dx,y+dy);
      const ray=Array.from({length:d+1},(_,k)=>square(x+k*sx,y+k*sy));
      const offRay=Array.from({length:64},(_,i)=>squareName(i)).filter(s=>!ray.includes(s));
      const blockers=[choose(offRay)];
      if (variation==='occupied-destination') blockers.push(to);
      if (variation==='first-blocker') blockers.push(ray[1]);
      if (variation==='last-blocker') blockers.push(ray[d-1]);
      if (variation==='random-blocker') blockers.push(choose(ray.slice(1,-1)));
      const occupied={[from]:'wq',...Object.fromEntries(blockers.map(s=>[s,'bp']))};
      const board=Array.from({length:64},(_,i)=>occupied[squareName(i)] ?? '');
      // The sole white attacker is the queen at the ray origin. The pinned
      // native attack query consequently isolates the path-clear property.
      const expected=attacked(board,squareOf(to),'w');
      assert.equal(expected,!variation.endsWith('blocker'));
      rows.push({id:'held-'+String(rows.length+1).padStart(3,'0'),x,y,dx,dy,occupied,expected});
    }
  }
  return {version:1,seed,rows};
}

if (import.meta.main) {
  const [mode,file]=process.argv.slice(2);
  assert.ok(file && ['create','verify'].includes(mode),'holdout.mjs create|verify PRIVATE_FILE');
  if(mode==='create') {
    const result=generate(randomBytes(32).toString('hex'));
    writeFileSync(file,JSON.stringify(result)+'\n',{mode:0o600,flag:'wx'});
  }
  const bytes=readFileSync(file);
  const input=JSON.parse(bytes);
  assert.deepEqual(input,generate(input.seed));
  const commitment={sha256:sha(bytes),cases:input.rows.length,
    allowed:input.rows.filter(r=>r.expected).length,refused:input.rows.filter(r=>!r.expected).length};
  if(mode==='verify') assert.deepEqual(commitment,JSON.parse(readFileSync(new URL('./holdout-lock.json',import.meta.url))));
  console.log(JSON.stringify(commitment,null,2));
}
