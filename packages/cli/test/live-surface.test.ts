/**
 * Live mode is its own package. `pyric` and `@pyric/cli` declare no bin,
 * export, flag, config key or environment variable that turns it on: the
 * only live surfaces they hold are the three internal seams `@pyric/live`
 * calls, and each refuses to start in a project without `@pyric/live`
 * installed. `test/e2e/live-command.pw.ts` starts `pyric sandbox --hosted`
 * with every live flag, key and variable a developer might try, and finds a
 * sandbox host.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli/parse-args.js';

const cliDir = fileURLToPath(new URL('../', import.meta.url));
const pyricDir = fileURLToPath(new URL('../../pyric/', import.meta.url));

interface Manifest {
  bin?: string | Record<string, string>;
  exports?: Record<string, unknown>;
}

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
}

function binNames(pkg: Manifest): string[] {
  if (pkg.bin === undefined) return [];
  return typeof pkg.bin === 'string' ? ['(default)'] : Object.keys(pkg.bin);
}

/** The seams `@pyric/live` calls, each gated on the installed package. */
const LIVE_SEAMS = ['./vite/internal/supplied-rows', './register/internal/supplied-rows', './serve/internal/live-host'];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const isDirectory = statSync(path).isDirectory();
    if (isDirectory) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.generated')) files.push(path);
  }
  return files;
}

const roots: string[] = [];
const startDir = process.cwd();
afterEach(() => {
  process.chdir(startDir);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pyric and @pyric/cli expose nothing live', () => {
  it('declare no live bin', () => {
    expect(binNames(manifest(cliDir))).toEqual(['pyric']);
    for (const name of binNames(manifest(pyricDir))) expect(name).not.toMatch(/live/i);
  });

  it('export only the internal seams @pyric/live calls', () => {
    const cliLive = Object.keys(manifest(cliDir).exports ?? {}).filter((key) => /live|supplied-rows/i.test(key));
    expect(cliLive.sort()).toEqual([...LIVE_SEAMS].sort());
    const pyricLive = Object.keys(manifest(pyricDir).exports ?? {}).filter((key) => /live/i.test(key));
    expect(pyricLive).toEqual([]);
  });

  it('parse no live flag: `--live` is an unknown flag pyric sandbox never reads', () => {
    const parsed = parseArgs(['sandbox', '--hosted', '--live']);
    expect(parsed.flags.get('live')).toBe(true);
    const sources = sourceFiles(join(cliDir, 'src'));
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/flags\.get\(['"][^'"]*live[^'"]*['"]\)/i);
    }
  });

  it('read no live config key or environment variable that turns live mode on', () => {
    const sources = [...sourceFiles(join(cliDir, 'src')), ...sourceFiles(join(pyricDir, 'src'))];
    const variables = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/PYRIC_[A-Z0-9_]*LIVE[A-Z0-9_]*/g)) variables.add(match[0]);
      expect(text, file).not.toMatch(/config\.live\b|pyricConfig\.live\b|\.live\s*===\s*true\s*\?\s*'live'/);
    }
    // Error codes, and the variable a live process passes its own children: it
    // names where to look, and live mode starts only by importing @pyric/live/register.
    expect([...variables].sort()).toEqual(['PYRIC_LIVE_NO_PROJECT', 'PYRIC_LIVE_PROJECT_ROOT', 'PYRIC_LIVE_REFUSED', 'PYRIC_TEST_PEER_LIVENESS_MS']);
  });
});

describe('the live host seam', () => {
  it('refuses to start in a project without @pyric/live installed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-no-live-')));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'no-live', private: true }));
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'no-live' } }));
    process.chdir(root);
    const { runLiveHost } = await import('../src/serve/live-host.js');
    await expect(runLiveHost(['--no-open'])).rejects.toThrow('live rows need @pyric/live installed in the project');
  });

  it('names the project the app\'s Firebase config sets, and refuses to start without one', async () => {
    const { liveHostProject, LiveProjectMissingError } = await import('../src/serve/live-host.js');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-project-')));
    roots.push(root);
    expect(() => liveHostProject([], root)).toThrow(LiveProjectMissingError);
    expect(() => liveHostProject([], root)).toThrow('Set one with `firebase use <project-id>`, or name it in .firebaserc');
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'from-rc' } }));
    expect(liveHostProject([], root)).toBe('from-rc');
    expect(liveHostProject(['--project', 'from-flag'], root)).toBe('from-flag');
  });
});
