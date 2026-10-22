import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectPackageManager, nextStepsFor } from '../src/package-manager.js';

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

/** Runs the create-pyric bin as a package manager's `create` would, and returns its next steps. */
function printedNextSteps(template: string, userAgent: string | undefined): string[] {
  const root = mkdtempSync(join(tmpdir(), 'create-pyric-pm-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.npm_config_user_agent;
    if (userAgent !== undefined) env.npm_config_user_agent = userAgent;
    const run = spawnSync(process.execPath, [BIN, join(root, 'app'), '--template', template], {
      encoding: 'utf8',
      env,
    });
    expect(run.status).toBe(0);
    const [, steps = ''] = run.stdout.split('Next steps:\n');
    return steps.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('create-pyric next steps', () => {
  it('prints npm steps under npm create', () => {
    expect(printedNextSteps('web', 'npm/11.13.0 node/v24.16.0 linux x64 workspaces/false')).toEqual([
      'npm install',
      'npm run dev    # vite dev on the pyric sandbox',
      'npm run build  # production build against real Firebase',
    ]);
  });

  it('prints bun steps under bun create', () => {
    expect(printedNextSteps('web', 'bun/1.3.14 npm/? node/v24.3.0 linux x64')[0]).toBe('bun install');
  });

  it('prints pnpm steps for the Next.js template', () => {
    expect(printedNextSteps('nextjs', 'pnpm/9.15.0 npm/? node/v22.15.0 linux x64')).toEqual([
      'pnpm install',
      'pnpm run dev    # Next.js dev server on the Pyric sandbox',
      'pnpm run build  # production build against real Firebase',
    ]);
  });

  it('prints npm steps when run directly', () => {
    expect(printedNextSteps('node', undefined)[0]).toBe('npm install');
  });
});

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

  it('rewrites npm steps and drops the named alternative', () => {
    expect(nextStepsFor(['npm install    # or: bun install', 'cd app'], 'yarn')).toEqual(['yarn install', 'cd app']);
  });
});
