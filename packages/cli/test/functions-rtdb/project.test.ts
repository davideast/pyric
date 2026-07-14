import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverFunctionsRtdbProject } from '../../src/functions-rtdb/project.js';

function project(config: unknown, packageJson?: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-project-'));
  writeFileSync(join(cwd, 'firebase.json'), JSON.stringify(config));
  if (packageJson !== undefined) {
    mkdirSync(join(cwd, 'functions'), { recursive: true });
    writeFileSync(join(cwd, 'functions/package.json'), JSON.stringify(packageJson));
  }
  return cwd;
}

describe('discoverFunctionsRtdbProject', () => {
  test('returns null when firebase.json does not declare Functions', () => {
    const cwd = project({ hosting: { public: 'public' } });
    expect(discoverFunctionsRtdbProject(cwd)).toBeNull();
  });

  test('uses functions.source and the package main entry', () => {
    const cwd = project(
      { functions: { source: 'functions' } },
      { name: 'fixture', main: 'lib/index.cjs' },
    );
    mkdirSync(join(cwd, 'functions/lib'));
    writeFileSync(join(cwd, 'functions/lib/index.cjs'), 'exports.noop = true;');

    expect(discoverFunctionsRtdbProject(cwd)).toEqual({
      sourceDir: join(cwd, 'functions'),
      entry: join(cwd, 'functions/lib/index.cjs'),
    });
  });

  test('defaults the source and entry to functions/index.js', () => {
    const cwd = project({ functions: {} }, { name: 'fixture' });
    writeFileSync(join(cwd, 'functions/index.js'), 'exports.noop = true;');

    expect(discoverFunctionsRtdbProject(cwd)?.entry).toBe(join(cwd, 'functions/index.js'));
  });

  test('rejects multiple codebases in the one-source first slice', () => {
    const cwd = project({
      functions: [
        { source: 'functions-a', codebase: 'a' },
        { source: 'functions-b', codebase: 'b' },
      ],
    });
    expect(() => discoverFunctionsRtdbProject(cwd)).toThrow(/multiple Functions codebases.*one source/s);
  });

  test('reports a declared source whose package or entry is missing', () => {
    const noPackage = project({ functions: { source: 'functions' } });
    expect(() => discoverFunctionsRtdbProject(noPackage)).toThrow(/functions\/package\.json/);

    const noEntry = project(
      { functions: { source: 'functions' } },
      { name: 'fixture', main: 'lib/missing.js' },
    );
    expect(() => discoverFunctionsRtdbProject(noEntry)).toThrow(/lib\/missing\.js/);
  });
});
