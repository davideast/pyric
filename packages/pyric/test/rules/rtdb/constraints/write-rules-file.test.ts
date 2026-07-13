import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allow, defineRtdbRules, deny } from '../../../../src/rules/rtdb/constraints/index.js';
import { writeRtdbRulesFile } from '../../../../src/rules/rtdb/constraints/write-rules-file.js';

describe('writeRtdbRulesFile', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test('writes doc.toJSON() to the given path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pyric-rtdb-rules-'));
    const doc = defineRtdbRules({
      paths: {
        '/': { read: deny(), write: deny() },
        '/public': { read: allow(), write: deny() },
      },
    });

    const outPath = join(dir, 'database.rules.json');
    const resolved = await writeRtdbRulesFile(doc, outPath);

    expect(resolved).toBe(outPath);
    const written = readFileSync(outPath, 'utf-8');
    expect(JSON.parse(written)).toEqual(doc.toJSON());
    expect(written).toBe(`${JSON.stringify(doc.toJSON(), null, 2)}\n`);
  });

  test('creates parent directories that do not exist yet', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pyric-rtdb-rules-'));
    const doc = defineRtdbRules({ paths: { '/': { read: allow(), write: deny() } } });

    const outPath = join(dir, 'nested', 'deeper', 'database.rules.json');
    await writeRtdbRulesFile(doc, outPath);

    expect(JSON.parse(readFileSync(outPath, 'utf-8'))).toEqual(doc.toJSON());
  });
});
