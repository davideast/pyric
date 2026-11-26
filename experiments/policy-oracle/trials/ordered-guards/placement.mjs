import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [installed] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(installed, 'package.json')));
const {compileFunction} = await import(pathToFileURL(resolve(installed, pkg.exports['./experimental/policy'].import)));
function source(collection) {
  return `use extension loops;
function choose(items) {
  for (const i of ${collection}) {
    if (items[i].a) return 1;
    if (items[i].b) return 2;
    if (items[i].c) return 3;
  }
  return 4;
}`;
}
const small = compileFunction(source('[0]'));
function smallInteger(value) {
  assert.ok(typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)));
  assert.ok(value >= 1 && value <= 4);
  return Number(value);
}
const values = [[true,true,true], [false,true,true], [false,false,true], [false,false,false]]
  .map(([a,b,c]) => smallInteger(small([{a,b,c}])));
assert.deepEqual(values, [1,2,3,4]);
const emitted = small.firestoreModule();
assert.match(emitted, /export function choose\(items\)/);

// The same three-guard body, with an input just large enough to make the
// helper's conservative target estimate exceed its allowance.
let firstRefusal;
for (let length = 2; length <= 400; length++) {
  const policy = compileFunction(source('[' + Array(length).fill(0).join(',') + ']'));
  try {
    policy.firestoreModule();
  } catch (error) {
    assert.match(error.message, /unrolled helper cannot prove its 1000-expression budget/);
    assert.equal(smallInteger(policy([{a:false,b:false,c:false}])),4);
    firstRefusal = {length, fallback:4, diagnostic:error.message};
    break;
  }
}
assert.ok(firstRefusal);
console.log(JSON.stringify({values, emitted, firstRefusal}, null, 2));
