import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {bundle,compile} from './fixture.mjs';

const manifest = pathToFileURL(resolve(process.argv[2]));
const pkg = JSON.parse(readFileSync(manifest));
assert.equal(pkg.name,'@pyric/rules');
const entry = new URL(pkg.exports['./experimental/policy'].import,manifest);
const {compileFunction} = await import(entry);
process.stdout.write(bundle(compile(compileFunction)));
