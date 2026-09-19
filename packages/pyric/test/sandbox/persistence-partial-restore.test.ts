import { expect, test } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from '../../src/sandbox/index.js';
import { bundleRecords, checksumDocs, META_RECORD_ID } from '../../src/sandbox/persistence/chunk-format.js';
import { decodeImportBundle } from '../../src/sandbox/persistence/import-bundle.js';

function recordsWith(data: unknown, encoding?: string): Map<string, unknown> {
  const docs = { 'notes/first': { title: 'first' }, 'notes/bad': data, 'notes/last': { title: 'last' } };
  return new Map<string, unknown>([
    [META_RECORD_ID, { version: 3, savedAt: 0, services: {} }],
    ['00', { docs, checksum: checksumDocs(docs), encoding }],
    ['01', { docs: { 'notes/other': { title: 'other' } } }],
  ]);
}

function deeplyNestedDocument(): unknown {
  let value: unknown = { title: 'too deep' };
  for (let level = 0; level < 65; level++) value = { nested: value };
  return value;
}

for (const [name, data] of [['array root', []], ['excessive depth', deeplyNestedDocument()]] as const) {
  test(`shared restore skips ${name} and keeps neighboring documents`, async () => {
    const backend = createMemoryBackend();
    const records = recordsWith(data);
    await backend.putRecords('partial', records);
    const sandbox = initializeSandbox();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      await sandbox.enablePersistence({ key: 'partial', injectedBackend: backend });
      expect(sandbox.admin.getDocument('notes/first')).toEqual({ title: 'first' });
      expect(sandbox.admin.getDocument('notes/last')).toEqual({ title: 'last' });
      expect(sandbox.admin.getDocument('notes/other')).toEqual({ title: 'other' });
      expect(sandbox.admin.getDocument('notes/bad')).toBeNull();
      expect(warnings.some(line => line.includes('notes/bad') && line.includes('00'))).toBe(true);
      expect(await backend.getRecord('partial', '00')).toEqual(records.get('00'));
    } finally {
      console.warn = original;
    }
  });

  test(`strict state import still rejects ${name}`, () => {
    expect(() => decodeImportBundle(bundleRecords(recordsWith(data)))).toThrow();
  });
}

test('shared restore reports unknown bucket encoding and restores other buckets', async () => {
  const backend = createMemoryBackend();
  const records = recordsWith({ title: 'future' }, 'pyric/firestore-values/future');
  await backend.putRecords('partial', records);
  const sandbox = initializeSandbox();
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    await sandbox.enablePersistence({ key: 'partial', injectedBackend: backend });
    expect(sandbox.admin.getDocument('notes/other')).toEqual({ title: 'other' });
    expect(sandbox.admin.getDocument('notes/bad')).toBeNull();
    expect(warnings.some(line => line.includes('notes/bad') && line.includes('00'))).toBe(true);
    expect(await backend.getRecord('partial', '00')).toEqual(records.get('00'));
    expect(() => decodeImportBundle(bundleRecords(records))).toThrow('Unsupported Firestore value encoding.');
  } finally {
    console.warn = original;
  }
});
