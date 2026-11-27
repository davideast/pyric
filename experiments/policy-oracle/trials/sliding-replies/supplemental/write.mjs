import {readFileSync} from 'node:fs';
import {sample} from '../../chess-safety/reference/fixtures.mjs';

function write(frozen) {
  const {before,proposal}=sample(frozen,'writer','other');
  return {description:frozen.id,path:'chess/explore',method:'update',auth:{uid:'writer'},
    resource:before,data:{...before,...proposal},expectation:'ALLOW'};
}

const frozen=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify(Array.isArray(frozen)?frozen.map(write):write(frozen)));
