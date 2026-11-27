import {readFileSync} from 'node:fs';
import {sample} from '../../chess-safety/reference/fixtures.mjs';
const frozen=JSON.parse(readFileSync(0,'utf8'));
const {before,proposal}=sample(frozen,'writer','other');
console.log(JSON.stringify({description:frozen.id,path:'chess/explore',method:'update',auth:{uid:'writer'},
  resource:before,data:{...before,...proposal},expectation:'ALLOW'}));
