import {readFileSync} from 'node:fs';
import {cases, sample} from './reference/fixtures.mjs';

// Executed by the verifier; neither the candidate package nor its emitted
// code participates in constructing proposed writes or native answers.
const cost = JSON.parse(readFileSync(new URL('reference/cost-native.json',import.meta.url))).cases;
const path = JSON.parse(readFileSync(new URL('reference/path-native.json',import.meta.url))).cases;
const rows = [...cases,...cost,...path].map(c => {
  const {before,proposal} = sample(c,'writer','other');
  const data = {...before,...proposal};
  return {id:c.id, file:c.uci[0], color:before.currentTurn === 'host' ? 'w' : 'b',
    request:{description:c.id,method:'update',path:'chess/oracle',auth:{uid:'writer'},
      resource:before,data,expectation:'ALLOW'}};
});
console.log(JSON.stringify(rows));
