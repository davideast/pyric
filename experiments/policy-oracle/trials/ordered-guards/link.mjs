import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha} from '../../arcade/corpus.mjs';
import {linkCandidate} from '../for-of/link.mjs';

const [packageDir, resolver, output] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json')));
const {compileFunction} = await import(pathToFileURL(resolve(packageDir, pkg.exports['./experimental/policy'].import)));
const {resolveModules} = await import(pathToFileURL(resolve(resolver)));
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const pathSource = read('../for-of/reference/author-trial/loop/first.policy');
assert.equal(sha(pathSource), 'be308877884422ea30634a2ec02187ab541ddf88ef7259bdfb0e7b5faae6c114');
const linked = linkCandidate(compileFunction, resolveModules, output, {
  pathSource, witnessSource: read('policies/first-hit.policy'),
});
console.log(JSON.stringify(linked, null, 2));
