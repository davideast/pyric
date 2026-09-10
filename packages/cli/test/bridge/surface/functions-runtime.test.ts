import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverFunctionsTriggers } from '../../../src/bridge/surface/functions-runtime.js';

const firebaseFunctionsPath = resolve(
  import.meta.dir,
  '../../../../conformance/node_modules/firebase-functions',
);

function fixtureProject(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-functions-runtime-'));
}

function plantFunctionsSource(projectDir: string, source: string): void {
  mkdirSync(join(projectDir, 'functions/node_modules'), { recursive: true });
  writeFileSync(join(projectDir, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
  writeFileSync(
    join(projectDir, 'functions/package.json'),
    JSON.stringify({ name: 'fixture-functions', private: true, main: 'index.js' }),
  );
  writeFileSync(join(projectDir, 'functions/index.js'), source);
  symlinkSync(firebaseFunctionsPath, join(projectDir, 'functions/node_modules/firebase-functions'));
}

describe('discoverFunctionsTriggers', () => {
  test('reports an empty discovery, naming where it looked, when the project declares no functions source', async () => {
    const projectDir = fixtureProject();
    const discovered = await discoverFunctionsTriggers(projectDir);
    expect(discovered.triggers).toEqual([]);
    expect(discovered.unsupported).toEqual([]);
    expect(discovered.lookedAt).toBe(`${projectDir}/firebase.json`);
  });

  test('discovers a supported onValueCreated export and names an unsupported one with its reason', async () => {
    const projectDir = fixtureProject();
    plantFunctionsSource(
      projectDir,
      `const { onValueCreated } = require('firebase-functions/v2/database');
exports.makeUppercase = onValueCreated('/messages/{pushId}/original', (event) => (
  event.data.val().toUpperCase()
));
exports.turnedOff = onValueCreated({ ref: '/messages/{id}', omit: true }, () => undefined);
`,
    );
    const discovered = await discoverFunctionsTriggers(projectDir);
    expect(discovered.triggers).toHaveLength(1);
    expect(discovered.triggers[0]).toMatchObject({
      exportName: 'makeUppercase',
      reference: 'messages/{pushId}/original',
    });
    expect(discovered.unsupported).toEqual([
      {
        exportName: 'turnedOff',
        eventType: 'google.firebase.database.ref.v1.created (omitted from emulation)',
      },
    ]);
  });
});
