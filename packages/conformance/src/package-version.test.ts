import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  resolvePackageJsonPath,
  resolvePackageVersion,
  resolvedAdminVersion,
  resolvedFirebaseVersion,
  resolvedFunctionsVersion,
} from './package-version.ts';

describe('package-version utility (walk-up resolver)', () => {
  test('resolves installed firebase client version', () => {
    const version = resolvedFirebaseVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('resolves installed firebase-admin server version', () => {
    const version = resolvedAdminVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('resolves installed firebase-functions version', () => {
    const version = resolvedFunctionsVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('locates valid package.json on disk matching package name', () => {
    const adminPath = resolvePackageJsonPath('firebase-admin');
    expect(existsSync(adminPath)).toBe(true);
    const content = JSON.parse(readFileSync(adminPath, 'utf8')) as { name: string; version: string };
    expect(content.name).toBe('firebase-admin');
    expect(content.version).toBe(resolvedAdminVersion());

    const fbPath = resolvePackageJsonPath('firebase');
    expect(existsSync(fbPath)).toBe(true);
    const fbContent = JSON.parse(readFileSync(fbPath, 'utf8')) as { name: string; version: string };
    expect(fbContent.name).toBe('firebase');
    expect(fbContent.version).toBe(resolvedFirebaseVersion());
  });

  test('throws descriptive error on non-existent package', () => {
    expect(() => resolvePackageVersion('non-existent-dummy-pkg-12345')).toThrow(
      /Could not resolve any public entrypoint/,
    );
  });

  test('returns cached version on repeated calls', () => {
    const v1 = resolvePackageVersion('firebase');
    const v2 = resolvePackageVersion('firebase');
    expect(v1).toBe(v2);
  });
});
