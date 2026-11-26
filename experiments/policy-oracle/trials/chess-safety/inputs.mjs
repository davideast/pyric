import {readFileSync} from 'node:fs';
import {sample} from './reference/fixtures.mjs';
const rows=process.argv.slice(2).flatMap(file=>JSON.parse(readFileSync(file,'utf8')));
console.log(JSON.stringify(rows.map(c=>{
  const {before,proposal}=sample(c,'writer','other');
  return {description:c.id,path:'chess/oracle',method:'update',auth:{uid:'writer'},
    resource:before,data:{...before,...proposal},expectation:'ALLOW'};
})));
