import {cases,sample} from './fixtures.mjs';
console.log(JSON.stringify(cases.map(c=>{
  const {before,proposal}=sample(c,'player','opponent');
  return {description:c.id,path:'chess/example',method:'update',auth:{uid:'player'},
    resource:before,data:{...before,...proposal},expectation:'ALLOW'};
}),null,2));
