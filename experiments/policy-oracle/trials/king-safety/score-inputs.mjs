import {cases, sample} from './reference/fixtures.mjs';

// Executed by the verifier; neither the candidate package nor its emitted
// code participates in constructing proposed writes or native answers.
const rows = cases.map(c => {
  const {before,proposal} = sample(c,'writer','other');
  const data = {...before,...proposal};
  return {id:c.id, file:c.uci[0], color:before.currentTurn === 'host' ? 'w' : 'b',
    request:{description:c.id,method:'update',path:'chess/oracle',auth:{uid:'writer'},
      resource:before,data,expectation:'ALLOW'}};
});
console.log(JSON.stringify(rows));
