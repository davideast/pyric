import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCreateArgs } from '../src/parse-args.js';
import { runScaffold, applyDepsMode, TEMPLATES } from '../src/scaffold.js';

function bufferIo() {
  let out = '';
  let err = '';
  return {
    stdout: { write(s: string) { out += s; } },
    stderr: { write(s: string) { err += s; } },
    getOut: () => out,
    getErr: () => err,
  };
}

describe('parseCreateArgs', () => {
  it('treats the first bare arg as the directory (no subcommand)', () => {
    const args = parseCreateArgs(['my-app', '--force']);
    expect(args.positional).toEqual(['my-app']);
    expect(args.flags.get('force')).toBe(true);
  });

  it('accepts flags after a bare -- (npm create passthrough)', () => {
    const args = parseCreateArgs(['app', '--', '--template', 'static']);
    expect(args.positional).toEqual(['app']);
    expect(args.flags.get('template')).toBe('static');
  });
});

describe('runScaffold', () => {
  it('pins registry dependencies to the create-pyric package version', () => {
    const root = mkdtempSync(join(tmpdir(), 'create-pyric-version-'));
    const project = join(root, 'app');
    try {
      const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
      const run = spawnSync(process.execPath, [bin, project], { encoding: 'utf8' });
      expect(run.status).toBe(0);

      const ownPackage = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      const generated = JSON.parse(
        readFileSync(join(project, 'package.json'), 'utf8'),
      ) as { devDependencies: Record<string, string> };

      expect(generated.devDependencies['@pyric/cli']).toBe(`^${ownPackage.version}`);
      expect(run.stdout).toContain(`from npm (^${ownPackage.version})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes the Vite web scaffold by default', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    const mkdirFn = mock(async () => undefined);
    const code = await runScaffold(
      {
        dir: 'hello',
        commandLabel: 'create-pyric',
        effectiveTemplate: applyDepsMode(TEMPLATES.web, 'npm', { version: null }),
      },
      {
        ...io,
        cwd: '/tmp',
        writeFile: writeFn as never,
        mkdir: mkdirFn as never,
        exists: async () => false,
      },
    );
    expect(code).toBe(0);
    const paths = writeFn.mock.calls.map((c) => c[0] as string);
    expect(paths).toContain('/tmp/hello/package.json');
    expect(paths).toContain('/tmp/hello/vite.config.ts');
    const vite = writeFn.mock.calls.find((c) => String(c[0]).endsWith('vite.config.ts'));
    expect(vite?.[1]).toContain("from '@pyric/cli/vite'");
    expect(vite?.[1]).toContain('pyric()');
    expect(io.getOut()).toContain('create-pyric: scaffolded web');
  });

  it('scaffolds into cwd when dir is omitted', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    const code = await runScaffold(
      {
        template: 'node',
        commandLabel: 'create-pyric',
        effectiveTemplate: applyDepsMode(TEMPLATES.node, 'npm', { version: null }),
      },
      {
        ...io,
        cwd: '/tmp/cwd-scaffold',
        writeFile: writeFn as never,
        mkdir: mock(async () => undefined) as never,
        exists: async () => false,
      },
    );
    expect(code).toBe(0);
    expect(writeFn.mock.calls.some((c) => c[0] === '/tmp/cwd-scaffold/package.json')).toBe(true);
  });
});
