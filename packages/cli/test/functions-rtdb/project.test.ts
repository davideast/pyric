import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverFunctionsProject,
  type DiscoverFunctionsProjectOptions,
} from '../../src/functions/project.js';

const tempDirs: string[] = [];

function project(config: unknown, packageJson?: unknown, sourceSubdir = 'functions'): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-project-'));
  tempDirs.push(cwd);
  writeFileSync(join(cwd, 'firebase.json'), JSON.stringify(config));
  if (packageJson !== undefined) {
    mkdirSync(join(cwd, sourceSubdir), { recursive: true });
    writeFileSync(join(cwd, sourceSubdir, 'package.json'), JSON.stringify(packageJson));
  }
  return cwd;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverFunctionsProject', () => {
  test('returns null when firebase.json does not declare Functions', () => {
    const cwd = project({ hosting: { public: 'public' } });
    expect(discoverFunctionsProject(cwd)).toBeNull();
  });

  test('uses functions.source and the package main entry', () => {
    const cwd = project(
      { functions: { source: 'functions' } },
      { name: 'fixture', main: 'lib/index.cjs' },
    );
    mkdirSync(join(cwd, 'functions/lib'));
    writeFileSync(join(cwd, 'functions/lib/index.cjs'), 'exports.noop = true;');

    expect(discoverFunctionsProject(cwd)).toEqual({
      sourceDir: join(cwd, 'functions'),
      entry: join(cwd, 'functions/lib/index.cjs'),
    });
  });

  test('defaults the source and entry to functions/index.js', () => {
    const cwd = project({ functions: {} }, { name: 'fixture' });
    writeFileSync(join(cwd, 'functions/index.js'), 'exports.noop = true;');

    expect(discoverFunctionsProject(cwd)?.entry).toBe(join(cwd, 'functions/index.js'));
  });

  test('rejects multiple codebases in the one-source first slice', () => {
    const cwd = project({
      functions: [
        { source: 'functions-a', codebase: 'a' },
        { source: 'functions-b', codebase: 'b' },
      ],
    });
    expect(() => discoverFunctionsProject(cwd)).toThrow(/multiple Functions codebases.*one source/s);
  });

  test('throws when a declared source directory has no package.json', () => {
    const noPackage = project({ functions: { source: 'functions' } });
    expect(() => discoverFunctionsProject(noPackage)).toThrow(/functions\/package\.json/);
  });

  test('warns once and returns null when main build output does not exist yet, then resolves once built', () => {
    const warnings: string[] = [];
    const options: DiscoverFunctionsProjectOptions = {
      warn: (message) => {
        warnings.push(message);
      },
    };
    const unbuilt = project(
      { functions: { source: 'backend-fns' } },
      { name: 'fixture', main: 'lib/index.js' },
      'backend-fns',
    );

    expect(discoverFunctionsProject(unbuilt, options)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"backend-fns"');
    expect(warnings[0]).toContain('"lib/index.js"');
    expect(warnings[0]).toContain(join(unbuilt, 'backend-fns/lib/index.js'));

    // Repeated discovery while still unbuilt does not duplicate the warning.
    expect(discoverFunctionsProject(unbuilt, options)).toBeNull();
    expect(warnings).toHaveLength(1);

    mkdirSync(join(unbuilt, 'backend-fns/lib'), { recursive: true });
    writeFileSync(join(unbuilt, 'backend-fns/lib/index.js'), 'exports.ready = true;');

    expect(discoverFunctionsProject(unbuilt, options)).toEqual({
      sourceDir: join(unbuilt, 'backend-fns'),
      entry: join(unbuilt, 'backend-fns/lib/index.js'),
    });
  });
});
