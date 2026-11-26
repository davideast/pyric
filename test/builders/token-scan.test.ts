// The token scan, with a made-up value planted in a scratch tree. The scan
// reports files, never the value.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyRedacted, filesContaining, REDACTED, redactedText } from './token-scan.ts';

const SECRET = 'made-up-secret-for-the-scan-test';

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'builders-token-scan-'));
  mkdirSync(join(root, 'logs', 'deep'), { recursive: true });
  mkdirSync(join(root, 'logs', '.pyric', 'state'), { recursive: true });
  mkdirSync(join(root, 'logs', 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'clean.txt'), 'nothing here');
  writeFileSync(join(root, 'logs', 'deep', 'leak.log'), `before ${SECRET} middle ${SECRET} after`);
  writeFileSync(join(root, 'logs', '.pyric', 'state', 'store.db'), SECRET);
  writeFileSync(join(root, 'logs', 'node_modules', 'pkg', 'skipped.js'), SECRET);
  writeFileSync(join(root, 'node_modules', 'pkg', 'skipped.js'), SECRET);
  symlinkSync(join(root, 'logs', 'deep', 'leak.log'), join(root, 'link.log'));
  return root;
}

describe('filesContaining', () => {
  test('finds the value in a file of any depth, skipping node_modules, .pyric/state and links', () => {
    const root = tree();
    expect(filesContaining(root, SECRET)).toEqual([join(root, 'logs', 'deep', 'leak.log')]);
    expect(filesContaining(join(root, 'clean.txt'), SECRET)).toEqual([]);
    expect(filesContaining(join(root, 'missing'), SECRET)).toEqual([]);
  });
});

describe('copyRedacted and redactedText', () => {
  test('copies a tree with every occurrence replaced while skipping node_modules and .pyric/state', () => {
    const root = tree();
    const copy = join(mkdtempSync(join(tmpdir(), 'builders-token-copy-')), 'logs');
    copyRedacted(join(root, 'logs'), copy, SECRET);
    expect(readFileSync(join(copy, 'deep', 'leak.log'), 'utf8')).toBe(`before ${REDACTED} middle ${REDACTED} after`);
    expect(existsSync(join(copy, '.pyric', 'state'))).toBe(false);
    expect(existsSync(join(copy, 'node_modules'))).toBe(false);
    expect(filesContaining(copy, SECRET)).toEqual([]);
  });

  test('copies unchanged when the harness has no token', () => {
    const root = tree();
    const copy = join(mkdtempSync(join(tmpdir(), 'builders-token-copy-')), 'leak.log');
    copyRedacted(join(root, 'logs', 'deep', 'leak.log'), copy, undefined);
    expect(readFileSync(copy, 'utf8')).toContain(SECRET);
    expect(redactedText(`a ${SECRET}`, SECRET)).toBe(`a ${REDACTED}`);
    expect(redactedText('a', undefined)).toBe('a');
    expect(redactedText(`${SECRET} b other-made-up`, [SECRET, 'other-made-up'])).toBe(`${REDACTED} b ${REDACTED}`);
  });
});
