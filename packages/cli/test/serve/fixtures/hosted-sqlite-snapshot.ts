import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { serializeToBuckets } from 'pyric/sandbox';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { pathToFileURL } from 'node:url';
const { runSnapshot } = await import(pathToFileURL(join(process.cwd(), 'packages/cli/dist/cli/snapshot.js')).href);

const project = process.argv[2];
const persistence = await createHostedPersistence(project);
const records = serializeToBuckets({ 'notes/one': { value: 42 } }, {
  auth: { users: [{ uid: 'alice', email: 'alice@example.test', password: 'secret-password' }], providers: {} },
}, 0);
await persistence.backend.putRecords('hosted', records);
persistence.close();
const output = join(project, 'export.json');
const messages: string[] = [];
const result = await runSnapshot({ subcommand: 'snapshot', positional: [], flags: new Map([['out', output]]) }, {
  cwd: project, stdout: { write: value => { messages.push(value); } }, stderr: { write: value => { messages.push(value); } }, fetchLive: async () => null,
});
assert.equal(result, 0, messages.join('\n'));
const exported = readFileSync(output, 'utf8');
assert.doesNotMatch(exported, /secret-password/);
assert.match(exported, /__pyric_no_password__/);
assert.match(exported, /notes\/one/);
assert.equal(existsSync(join(project, '.pyric/state/state.json')), false);
console.log('Snapshot passed');
