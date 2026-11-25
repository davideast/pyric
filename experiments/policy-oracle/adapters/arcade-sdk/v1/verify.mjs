import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeEvidence, readProbe } from './evidence.mjs';

assert.equal(process.argv.length, 4, 'usage: bun verify.mjs <probe-directory> <absolute-raw-receipt>');
const [, , probeDir, receiptPath] = process.argv;
assert.ok(isAbsolute(receiptPath));
const probe = readProbe(pathToFileURL(resolve(probeDir) + sep));
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
console.log(JSON.stringify(normalizeEvidence(probe, receipt)));
