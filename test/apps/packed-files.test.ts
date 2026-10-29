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

/** A name too long for a ustar header, so tar writes a pax header or a GNU long name for it. */
const LONG_NAME = `${'a'.repeat(120)}.js`;

/** A path over 100 characters of short directories, which a ustar header splits into its prefix and name fields. */
const LONG_NESTED_PATH = `${'dir/'.repeat(30)}nested.js`;

describe('the files of a tarball', () => {
  test.each(['pax', 'gnu', 'ustar'] as const)('are read from a %s tar, by their path under the package directory', async (format) => {
    const work = tempDir();
    const files: Record<string, string> = {
      'package/package.json': '{"name":"p"}',
      'package/dist/ai/broker/upstream.js': 'export {};\n',
      [`package/dist/${LONG_NESTED_PATH}`]: 'nested\n',
    };
    if (format !== 'ustar') files[`package/dist/${LONG_NAME}`] = 'long\n';
    writeFiles(join(work, 'src'), files);
    const tarball = join(work, 'p.tgz');
    const packed = await runCommand('tar', [`--format=${format}`, '-czf', tarball, '-C', join(work, 'src'), 'package'], { cwd: work });
    expect(packed.code).toBe(0);
    const read = tarFiles(gunzipSync(readFileSync(tarball)));
    const expected = Object.fromEntries(Object.entries(files).map(([path, text]) => [path.slice('package/'.length), text]));
    expect(Object.fromEntries(read.map((file) => [file.path, file.body.toString('utf8')]))).toEqual(expected);
  });

  test('leave out a hard link, as npm does when it extracts the tarball', async () => {
    // pacote's extract filter drops every entry whose type ends in Link, so npm installs no file for one.
    const work = tempDir();
    writeFiles(join(work, 'src'), { 'package/package.json': '{"name":"p"}', 'package/a.js': 'abc\n' });
    const linked = await runCommand('ln', [join(work, 'src/package/a.js'), join(work, 'src/package/b.js')], { cwd: work });
    expect(linked.code).toBe(0);
    const tarball = join(work, 'p.tgz');
    const packed = await runCommand('tar', ['-czf', tarball, '-C', join(work, 'src'), 'package'], { cwd: work });
    expect(packed.code).toBe(0);
    const listing = await runCommand('tar', ['-tvzf', tarball], { cwd: work });
    const link = listing.output.match(/^h\S* .* package\/(\S+) link to package\/(\S+)$/m);
    expect(link).not.toBeNull();
    const [, linkPath = '', target = ''] = link ?? [];
    const read = tarFiles(gunzipSync(readFileSync(tarball))).map((file) => file.path);
    expect(read.sort()).toEqual([target, 'package.json'].sort());
    expect(read).not.toContain(linkPath);
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
