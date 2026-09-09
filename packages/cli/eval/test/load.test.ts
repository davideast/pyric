/**
 * The filename is the join key for a corpus or matrix record. A record that
 * states a different `id` has two keys, which is the defect the record
 * convention exists to prevent, so the loader refuses it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRows, loadTasks, RecordIdMismatchError, selectRecords } from '../load.js';

function recordsDir(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-records-'));
}

function writeTask(dir: string, filename: string, declaredId: string): void {
  writeFileSync(
    join(dir, `${filename}.ts`),
    `export default {
  id: ${JSON.stringify(declaredId)},
  prompt: 'p',
  seed: {},
  acceptedFirstOperations: [],
  assert: () => true,
  tags: [],
};
`,
    'utf8',
  );
}

function writeRow(dir: string, filename: string, declaredId: string): void {
  writeFileSync(
    join(dir, `${filename}.ts`),
    `export default {
  id: ${JSON.stringify(declaredId)},
  cli: 'claude',
  model: 'm',
  condition: 'agent-default',
  seeds: [1],
};
`,
    'utf8',
  );
}

describe('record loaders', () => {
  test('a task whose id matches its filename loads', async () => {
    const dir = recordsDir();
    writeTask(dir, 'read-a-post', 'read-a-post');
    const tasks = await loadTasks(dir);
    expect([...tasks.keys()]).toEqual(['read-a-post']);
    expect(tasks.get('read-a-post')?.prompt).toBe('p');
  });

  test('a task whose id disagrees with its filename is rejected', async () => {
    const dir = recordsDir();
    writeTask(dir, 'read-a-post', 'something-else');
    await expect(loadTasks(dir)).rejects.toThrow(RecordIdMismatchError);
  });

  test('a row whose id disagrees with its filename is rejected', async () => {
    const dir = recordsDir();
    writeRow(dir, 'claude-fable', 'claude-fable-mcp-only');
    await expect(loadRows(dir)).rejects.toThrow(RecordIdMismatchError);
  });

  test('records load in stable filename order', async () => {
    const dir = recordsDir();
    writeTask(dir, 'zeta', 'zeta');
    writeTask(dir, 'alpha', 'alpha');
    const tasks = await loadTasks(dir);
    expect([...tasks.keys()]).toEqual(['alpha', 'zeta']);
  });

  test('selecting an unknown id is an error, not a silent skip', async () => {
    const dir = recordsDir();
    writeTask(dir, 'alpha', 'alpha');
    const tasks = await loadTasks(dir);
    expect(selectRecords(tasks, ['alpha'])).toHaveLength(1);
    expect(selectRecords(tasks, [])).toHaveLength(1);
    expect(() => selectRecords(tasks, ['beta'])).toThrow('unknown record id: beta');
  });
});
