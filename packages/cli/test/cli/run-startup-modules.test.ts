/**
 * #1671: `pyric run` loads only what it needs before its first request. Its
 * refusal of an in-page Vite server is timed by the
 * run-names-hosted-for-in-page-vite app scenario, and nearly all of that time
 * was module loading: the CLI entry imported every command's module at
 * startup, about 600 modules with the TypeScript compiler among them, though
 * `run` needs under 20.
 *
 * The command runs in a real Node child from the built `dist/`, as the
 * installed bin runs, so this needs `bun run build` first. A load hook
 * records each module the child loads.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { closedPort } from '../closed-port.js';

const PACKAGE_ROOT = resolve(import.meta.dir, '../..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

/** Registers a load hook that writes each loaded module's URL to stderr. */
const RECORD_LOADS = `data:text/javascript,${encodeURIComponent(`
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, context, next) { process.stderr.write("LOADED " + url + "\\\\n"); return next(url, context); }'
));
`)}`;

/** Fewer than the entry loaded before #1671, with room for `run` to grow. */
const MODULE_LIMIT = 60;

function modulesLoadedBy(args: string[]): { code: number | null; modules: string[]; stderr: string } {
  const result = spawnSync('node', ['--import', RECORD_LOADS, CLI_ENTRY, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const lines = (result.stderr ?? '').split('\n');
  const modules = lines.filter((line) => line.startsWith('LOADED ')).map((line) => line.slice('LOADED '.length));
  const stderr = lines.filter((line) => !line.startsWith('LOADED ')).join('\n');
  return { code: result.status, modules, stderr };
}

describe('pyric run startup', () => {
  it('loads neither the service commands nor the TypeScript compiler before refusing', async () => {
    const port = await closedPort();
    const { code, modules, stderr } = modulesLoadedBy(['run', '--sandbox', `http://127.0.0.1:${port}`, '--', 'node', '-e', '0']);

    expect(stderr).toContain('no sandbox host answers');
    expect(code).toBe(2);
    expect(modules.some((url) => url.endsWith('/cli/run.js'))).toBe(true);
    const heavy = modules.filter((url) => /\/typescript\/|service-commands|\/cli\/(verify|snapshot|mcp-proxy)\.js$/.test(url));
    expect(heavy).toEqual([]);
    expect(modules.length).toBeLessThan(MODULE_LIMIT);
  });
});
