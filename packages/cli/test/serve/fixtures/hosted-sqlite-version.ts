import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const directory = process.argv[2];
const path = join(directory, 'state.sqlite');
const database = new DatabaseSync(path);
database.exec('CREATE TABLE future (value TEXT); INSERT INTO future VALUES (\'preserve me\'); PRAGMA user_version=999;');
database.close();
const before = readFileSync(path);
await assert.rejects(openHostedDatabase(directory), /Unsupported hosted database version 999/);
assert.deepEqual(readFileSync(path), before);
console.log('Version refusal passed');
