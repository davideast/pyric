import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import {
  expectSwiftFilesParseCleanly,
  parseSwiftFilesSyntax,
  resolveSwiftFrontendParseCommand,
} from './swift-syntax-parse.ts';

describe('resolveSwiftFrontendParseCommand and parseSwiftFilesSyntax', () => {
  it('prefers local, SWIFT_PATH, PATH, and realpath-sibling swift-frontend binaries with -parse', () => {
    const localCmd = resolveSwiftFrontendParseCommand({
      homeDir: '/home/tester',
      env: { SWIFT_PATH: '/usr/share/swift/usr/bin' },
      fileExists: (p) => p === '/home/tester/.local/swift/usr/bin/swift-frontend',
      which: () => '/usr/local/bin/swiftc',
    });
    expect(localCmd).toEqual({
      executable: '/home/tester/.local/swift/usr/bin/swift-frontend',
      prefixArgs: ['-parse'],
    });

    const envCmd = resolveSwiftFrontendParseCommand({
      homeDir: '/home/tester',
      env: { SWIFT_PATH: '/usr/share/swift/usr/bin' },
      fileExists: (p) => p === '/usr/share/swift/usr/bin/swift-frontend',
      which: (bin) => (bin === 'swiftc' ? '/usr/local/bin/swiftc' : null),
    });
    expect(envCmd).toEqual({
      executable: '/usr/share/swift/usr/bin/swift-frontend',
      prefixArgs: ['-parse'],
    });

    const pathCmd = resolveSwiftFrontendParseCommand({
      homeDir: '/home/tester',
      env: {},
      fileExists: () => false,
      which: (bin) => (bin === 'swift-frontend' ? '/opt/swift/bin/swift-frontend' : null),
    });
    expect(pathCmd).toEqual({
      executable: '/opt/swift/bin/swift-frontend',
      prefixArgs: ['-parse'],
    });

    const symlinkSiblingCmd = resolveSwiftFrontendParseCommand({
      homeDir: '/home/tester',
      env: {},
      fileExists: (p) => p === '/usr/share/swift/usr/bin/swift-frontend',
      which: (bin) => (bin === 'swiftc' ? '/usr/local/bin/swiftc' : null),
      realpath: () => '/usr/share/swift/usr/bin/swift-driver',
    });
    expect(symlinkSiblingCmd).toEqual({
      executable: '/usr/share/swift/usr/bin/swift-frontend',
      prefixArgs: ['-parse'],
    });
  });

  it('passes -frontend -parse when falling back to a non-symlink swiftc shim or when realpath fails', () => {
    const shimCmd = resolveSwiftFrontendParseCommand({
      homeDir: '/Users/tester',
      env: {},
      fileExists: () => false,
      which: (bin) => (bin === 'swiftc' ? '/usr/bin/swiftc' : null),
      realpath: (p) => p,
    });
    expect(shimCmd).toEqual({
      executable: '/usr/bin/swiftc',
      prefixArgs: ['-frontend', '-parse'],
    });

    const realpathErrorCmd = resolveSwiftFrontendParseCommand({
      homeDir: '/Users/tester',
      env: {},
      fileExists: () => false,
      which: (bin) => (bin === 'swiftc' ? '/usr/bin/swiftc' : null),
      realpath: () => {
        throw new Error('EACCES');
      },
    });
    expect(realpathErrorCmd).toEqual({
      executable: '/usr/bin/swiftc',
      prefixArgs: ['-frontend', '-parse'],
    });

    const missingCmd = resolveSwiftFrontendParseCommand({
      homeDir: '/home/tester',
      env: {},
      fileExists: () => false,
      which: () => null,
    });
    expect(missingCmd).toBeNull();
  });

  it('skips when no parser is resolved and enforces async timeout cleanup without blocking', async () => {
    const skipped = await parseSwiftFilesSyntax(['/does/not/matter.swift'], { command: null });
    expect(skipped).toEqual({ skipped: true });

    const timedOut = await parseSwiftFilesSyntax([], {
      command: {
        executable: process.execPath,
        prefixArgs: ['-e', 'setTimeout(() => {}, 30000)'],
      },
      timeoutMs: 120,
      killGraceMs: 100,
    });
    expect(timedOut.skipped).toBe(false);
    if (!timedOut.skipped) {
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.elapsedMs).toBeLessThan(5_000);
    }
  });

  it('parses valid Swift files and reports invalid Swift syntax when a local toolchain is installed', async () => {
    const resolved = resolveSwiftFrontendParseCommand();
    if (resolved === null) {
      return;
    }

    const tmp = createPrivateJobTmpDir('swift-parse-ut');
    try {
      const validFile = join(tmp, 'Valid.swift');
      const invalidFile = join(tmp, 'Invalid.swift');
      writeFileSync(validFile, 'struct Sample { let value: Int }\n', 'utf8');
      writeFileSync(invalidFile, 'func broken( {\n', 'utf8');

      const okRes = await parseSwiftFilesSyntax([validFile], { command: resolved });
      expect(okRes.skipped).toBe(false);
      if (!okRes.skipped) {
        expect(okRes.timedOut).toBe(false);
        expect(okRes.status).toBe(0);
      }
      await expectSwiftFilesParseCleanly([validFile], { command: resolved });

      const badRes = await parseSwiftFilesSyntax([invalidFile], { command: resolved });
      expect(badRes.skipped).toBe(false);
      if (!badRes.skipped) {
        expect(badRes.timedOut).toBe(false);
        expect(badRes.status).not.toBe(0);
        expect(badRes.stderr).toContain('error:');
      }
    } finally {
      removePrivateJobTmpDir(tmp);
    }
  });
});
