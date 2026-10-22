import { describe, expect, it } from 'bun:test';
import { detectPackageManager, nextStepsFor } from '../src/package-manager.js';

describe('detectPackageManager', () => {
  it('names the package manager from its user agent', () => {
    expect(detectPackageManager('npm/10.9.2 node/v22.15.0 linux x64 workspaces/false')).toBe('npm');
    expect(detectPackageManager('pnpm/9.15.0 npm/? node/v22.15.0 linux x64')).toBe('pnpm');
    expect(detectPackageManager('yarn/1.22.22 npm/? node/v22.15.0 linux x64')).toBe('yarn');
    expect(detectPackageManager('bun/1.3.14 npm/? node/v24.3.0 linux x64')).toBe('bun');
  });

  it('falls back to npm without a known user agent', () => {
    expect(detectPackageManager(undefined)).toBe('npm');
    expect(detectPackageManager('')).toBe('npm');
    expect(detectPackageManager('deno/2.0.0')).toBe('npm');
  });
});

describe('nextStepsFor', () => {
  const steps = ['bun install', 'bun run dev    # vite dev on the pyric sandbox', 'bun start  # production'];

  it('rewrites bun steps for npm', () => {
    expect(nextStepsFor(steps, 'npm')).toEqual([
      'npm install',
      'npm run dev    # vite dev on the pyric sandbox',
      'npm start  # production',
    ]);
  });

  it('keeps bun steps for bun', () => {
    expect(nextStepsFor(steps, 'bun')).toEqual(steps);
  });

  it('leaves steps that name another command unchanged', () => {
    const mixed = ['npm install    # or: bun install', 'cd app'];
    expect(nextStepsFor(mixed, 'pnpm')).toEqual(mixed);
  });
});
