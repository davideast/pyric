// This process runs trusted code only. Its input is text from the isolated compiler.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sources} from './policy-variant.mjs';
import {link} from './policy-variant.mjs';
const [reference,variant] = process.argv.slice(2);
const {parseFunctions} = await import(pathToFileURL(resolve(reference,'dist/grammar/FirestoreParser.js')));
const modules = JSON.parse(readFileSync(0,'utf8'));
const authored = sources(variant);
assert.deepEqual(Object.keys(modules).sort(),Object.keys(authored).sort(),'expected every authored helper');
for (const [name,text] of Object.entries(modules)) {
  assert.equal(typeof text,'string');
  const body = text.replace(/^\s*rules_version\s*=\s*'2\+modules';\s*export\s+/, '');
  assert.notEqual(body,text,'expected an exported function module');
  const functions = parseFunctions(body);
  assert.equal(functions?.length,1,'expected one parseable function');
  assert.equal(functions[0].name,name,'unexpected function name');
}
const source=link(modules,variant);
const base=readFileSync(new URL('../chess-safety/artefacts/knight-endgame-paired-pawn-combined-bare-fixed-comma-packed-v5.rules',import.meta.url),'utf8');
function bindings(text) {
  const i=text.indexOf('match /databases/{database}/documents {');
  assert.ok(i>0,'complete Arcade match block missing');
  return text.slice(i);
}
assert.equal(bindings(source),bindings(base),'complete match or authorization bindings changed');
console.log(JSON.stringify({source}));
