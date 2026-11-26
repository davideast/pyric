import assert from 'node:assert/strict';
import {compress} from './endings.mjs';
import {loadPolicyApi} from '../../../king-safety/policy/public-api.mjs';
const {compileFunction}=await loadPolicyApi(process.argv[2]);
const tiny='function sourceProbe() { return true; }';
const atLimit=tiny.padEnd(8192,' ');
assert.equal(compileFunction(atLimit)(),true);
function rejected(source){
  try{compileFunction(source);throw Error('unexpected source acceptance');}
  catch(error){assert.match(error.message,/Source exceeds 8192 characters/);return error.message;}
}
const table=compress();
const raw=`function tableProbe(a,d,s) { let start = (s * 80 + d) * ${table.width}; let row = int('${table.header}'[start:start+${table.width}]); return '${table.data}'[row*80+a]; }`;
console.log(JSON.stringify({authority:'public compiler API',acceptedLength:atLimit.length,firstRejectedLength:atLimit.length+1,
  boundary:rejected(atLimit+' '),tableRows:table.entries,monolithicChars:raw.length,monolithicDiagnostic:rejected(raw)},null,2));
