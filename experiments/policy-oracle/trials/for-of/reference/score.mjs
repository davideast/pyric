import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const frozen = JSON.parse(readFileSync(new URL('./cases.json',import.meta.url)));
const suites = {
  rook:frozen.rook.map(row => ({id:row.id,expected:{value:row.expected}})),
  tally:frozen.tally,
  proposed:frozen.proposed
};

function compare(expectedRows, actualRows) {
  assert.deepEqual(actualRows.map(row => row.id), expectedRows.map(row => row.id), 'missing, extra or reordered observations');
  const divergences=[];
  for(const [i, reference] of expectedRows.entries()) {
    const actual=actualRows[i];
    assert.notEqual(Object.hasOwn(actual,'value'), Object.hasOwn(actual,'error'), actual.id+' needs exactly one of value or error');
    if(Object.hasOwn(actual,'error')) assert.ok(typeof actual.diagnostic==='string' && actual.diagnostic.trim(), actual.id+' missing diagnostic');
    const key=Object.hasOwn(reference.expected,'value')?'value':'error';
    if(!Object.hasOwn(actual,key) || actual[key]!==reference.expected[key]) {
      const observed=Object.hasOwn(actual,'value')?{value:actual.value}:{error:actual.error,diagnostic:actual.diagnostic};
      divergences.push({id:actual.id,expected:reference.expected,observed});
    }
  }
  return {cases:expectedRows.length,matches:expectedRows.length-divergences.length,
    firstDivergence:divergences[0]??null,divergences};
}

export function score(candidate) {
  const reports={};
  for (const [name,rows] of Object.entries(suites)) reports[name]=compare(rows,candidate[name]);
  const mutations={};
  for (const [mutant,name] of [['ignore-sixth-square','rook'],['reverse-actions','tally']]) {
    const result=compare(suites[name],candidate.mutants[mutant]);
    const witness=frozen.sensitivity[mutant], first=result.firstDivergence;
    mutations[mutant]={...result,sensitive:!!first && first.id===witness.first &&
      first.expected.value===witness.expected && first.observed.value===witness.mutant};
  }
  const passed=Object.values(reports).every(r=>r.firstDivergence===null) && Object.values(mutations).every(r=>r.sensitive);
  return {passed,reports,mutations};
}

if(import.meta.main) {
  assert.ok(process.argv[2],'Pass the observation JSON from the candidate run');
  const result=score(JSON.parse(readFileSync(process.argv[2])));
  console.log(JSON.stringify(result,null,2));
  if(!result.passed) process.exitCode=1;
}
