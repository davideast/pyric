import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { squareName } from '../../chess/reference/arcade-reference.ts';
import { generate } from './holdout.mjs';

const [privateFile,sourceFile,lockedSource,packageDir,compilerKind='function',exportName='pathClear']=process.argv.slice(2);
assert.ok(packageDir && ['function','module'].includes(compilerKind),
  'author-score.mjs PRIVATE_FILE LOCKED_SOURCE EXPECTED_SOURCE_SHA PACKAGE_DIRECTORY [function|module] [EXPORT]');
const sha = b => createHash('sha256').update(b).digest('hex');
const bytes=readFileSync(privateFile), corpus=JSON.parse(bytes);
const sealed=JSON.parse(readFileSync(new URL('./holdout-lock.json',import.meta.url)));
assert.equal(sha(bytes),sealed.sha256);
assert.deepEqual(corpus,generate(corpus.seed));
const source=readFileSync(sourceFile);
assert.equal(sha(source),lockedSource,'submission changed since lock');
const manifest=JSON.parse(readFileSync(join(packageDir,'package.json')));
const entry=resolve(packageDir,manifest.exports['./experimental/policy'].import);
const compiler=await import(pathToFileURL(entry).href);
let invoke,compileError=null;
try {
  if(compilerKind==='function') invoke=compiler.compileFunction(source.toString());
  else {
    const {moduleSource}=compiler.compileBoundedModule(source.toString());
    const mod=await import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));
    invoke=mod[exportName];
  }
  assert.equal(typeof invoke,'function','missing selected entry point');
} catch(error) { compileError=String(error.message ?? error); }
const observations=corpus.rows.map(row => {
  if(compileError) return {id:row.id,expected:row.expected,compileError};
  const board=Object.fromEntries(Array.from({length:64},(_,n) => {
    const sq=squareName(n);
    return [sq,row.occupied[sq]??''];
  }));
  try {
    const value=invoke(board,row.x,row.y,row.dx,row.dy);
    if(typeof value==='boolean') return {id:row.id,expected:row.expected,value};
    return {id:row.id,expected:row.expected,invalidReturn:String(value?.message??value)};
  } catch(error) { return {id:row.id,expected:row.expected,error:String(error.message??error)}; }
});
const failures=observations.filter(row => row.expected!==row.value);
console.log(JSON.stringify({sourceSha256:lockedSource,corpusSha256:sealed.sha256,compilerKind,
  compileError,cases:observations.length,matches:observations.length-failures.length,firstDivergence:failures[0]??null,
  falseAllows:failures.filter(r=>r.value===true).length,falseRefusals:failures.filter(r=>r.value===false).length,
  unsupported:failures.filter(r=>!Object.hasOwn(r,'value')).length},null,2));
if(failures.length) process.exitCode=1;
