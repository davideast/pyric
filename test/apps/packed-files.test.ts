import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { runCommand } from './install.ts';
import { installedFileProblems, tarFiles } from './packed-files.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-packed-files-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A name too long for a ustar header, so tar writes a pax header for it. */
const LONG_NAME = `${'a'.repeat(120)}.js`;

describe('the files of a tarball', () => {
  test.each(['pax', 'gnu', 'ustar'] as const)('are read from a %s tar, by their path under the package directory', async (format) => {
    const work = tempDir();
    const files: Record<string, string> = { 'package/package.json': '{"name":"p"}', 'package/dist/ai/broker/upstream.js': 'export {};\n' };
    if (format !== 'ustar') files[`package/dist/${LONG_NAME}`] = 'long\n';
    writeFiles(join(work, 'src'), files);
    const tarball = join(work, 'p.tgz');
    const packed = await runCommand('tar', [`--format=${format}`, '-czf', tarball, '-C', join(work, 'src'), 'package'], { cwd: work });
    expect(packed.code).toBe(0);
    const read = tarFiles(gunzipSync(readFileSync(tarball)));
    const expected = Object.fromEntries(Object.entries(files).map(([path, text]) => [path.slice('package/'.length), text]));
    expect(Object.fromEntries(read.map((file) => [file.path, file.body.toString('utf8')]))).toEqual(expected);
  });
});

describe('an installed package', () => {
  const expected = new Map([['package.json', 12], ['dist/index.js', 5]]);

  test('that holds exactly its tarball\'s files has no problems; its own node_modules does not count', () => {
    const dir = join(tempDir(), 'pyric-admin');
    writeFiles(dir, { 'package.json': '{"name":"p"}', 'dist/index.js': '1234\n', 'node_modules/zod/package.json': '{}' });
    expect(installedFileProblems(dir, expected)).toEqual([]);
  });

  test('names each file missing, of another size, or not in the tarball', () => {
    const dir = join(tempDir(), 'pyric-admin');
    writeFiles(dir, { 'package.json': '{"name":"pp"}', 'old.js': '' });
    expect(installedFileProblems(dir, expected)).toEqual([
      'package.json is 13 bytes, the tarball\'s is 12',
      'missing dist/index.js',
      'old.js is not in the tarball',
    ]);
  });

  test('that is not there says so', () => {
    expect(installedFileProblems(join(tempDir(), 'pyric-admin'), expected)).toEqual(['not installed']);
  });
});
