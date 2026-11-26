import assert from 'node:assert/strict';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';
import {lineSources} from './line-search.mjs';
import {squares} from './geometry.mjs';

const [pkg]=process.argv.slice(2);
const {compileFunction}=await loadPolicyApi(pkg);
const api=Object.fromEntries(Object.entries(lineSources()).map(([name,src])=>[name,compileFunction(src)]));
const result={cases:0,clear:0,blocked:0,orientations:2};
for(const rising of [true,false]) {
  for(let key=rising?-7:0;key<=(rising?7:14);key++) {
    const cells=[];
    for(let y=0;y<8;y++) {
      const x=rising?key+y:key-y;
      if(x>=0&&x<8) cells.push({y,sq:squares[y*8+x]});
    }
    for(let mask=0;mask<1<<cells.length;mask++) {
      const b=Object.fromEntries(squares.map(s=>[s,'']));
      cells.forEach(({sq},i)=>{if(mask&(1<<i)) b[sq]=i%2?'bn':'wp';});
      const line=(rising?api.risingLine:api.fallingLine)(b,key);
      for(let a=0;a<cells.length;a++) for(let z=0;z<cells.length;z++) {
        if(a===z) continue;
        let clear=true;
        for(let i=Math.min(a,z)+1;i<Math.max(a,z);i++) if(mask&(1<<i)) clear=false;
        assert.equal(api.clearBetween(line,cells[a].y,cells[z].y),clear,JSON.stringify({key,rising,mask,a,z}));
        result.cases++;if(clear)result.clear++;else result.blocked++;
      }
    }
  }
}
console.log(JSON.stringify(result,null,2));
