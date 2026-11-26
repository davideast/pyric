import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [candidate] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(candidate,'package.json')));
const {compileFunction} = await import(pathToFileURL(resolve(candidate,pkg.exports['./experimental/policy'].import)));
const clear = compileFunction(readFileSync(new URL('horizontal-path.policy',import.meta.url),'utf8'));
const files = 'abcdefgh';
let cases=0, clearPaths=0;
for (const rank of '12345678') for (let occupied=0; occupied<256; occupied++) {
  const board = Object.fromEntries([...files].map((f,x)=>[f+rank, occupied & (1<<x) ? (x%2 ? 'br':'wn') : '']));
  for (let x=0; x<8; x++) for (let to=0; to<8; to++) {
    if (x===to) continue;
    const step = Math.sign(to-x);
    let expected = true;
    for (let i=x+step; i!==to; i+=step) if (occupied & (1<<i)) expected=false;
    assert.equal(clear(board,rank,x,to),expected,files[x]+rank+files[to]+rank+' '+occupied);
    cases++;
    if (expected) clearPaths++;
  }
}
console.log(JSON.stringify({cases,clearPaths,blockedPaths:cases-clearPaths},null,2));
