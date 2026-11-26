import assert from 'node:assert/strict';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';
import {lineSources} from './lines.mjs';
const {compileFunction}=await loadPolicyApi(process.argv[2]);
const fns=Object.fromEntries(Object.entries(lineSources()).map(([name,source])=>[name,compileFunction(source)]));
let checked=0;
const files='abcdefgh';
for(const [name,fn] of Object.entries(fns)) {
  for(let mask=0;mask<256;mask++)for(let label=0;label<8;label++) {
    const line=name==='filedClear'?files[label]:String(label+1);
    const board={};
    for(let i=0;i<8;i++)board[name==='filedClear'?line+(i+1):files[i]+line]=(mask&(1<<i))?'bp':'';
    for(let a=0;a<8;a++)for(let b=0;b<8;b++) {
      let clear=true;
      for(let i=Math.min(a,b)+1;i<Math.max(a,b);i++)if(mask&(1<<i))clear=false;
      assert.equal(fn(board,line,a,b),clear);
      checked++;
    }
  }
}
console.log(JSON.stringify({rankAndFileClearanceDecisions:checked},null,2));
