import { describe, expect, it, mock } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCreateArgs } from '../src/parse-args.js';
import { runScaffold, applyDepsMode, TEMPLATES } from '../src/scaffold.js';
import { loadAssetTemplate } from '../src/templates.js';

function treeBytes(root: string): number {
  return readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(root, entry.name);
    return total + (entry.isDirectory() ? treeBytes(path) : statSync(path).size);
  }, 0);
}

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

  it('accepts chat as a named template value', () => {
    const args = parseCreateArgs(['my-chat', '--template', 'chat']);
    expect(args.positional).toEqual(['my-chat']);
    expect(args.flags.get('template')).toBe('chat');
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

  it('scaffolds the full chat template quickly from one allowlisted source tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'create-pyric-chat-'));
    const project = join(root, 'thinking-room');
    const io = bufferIo();
    try {
      const started = performance.now();
      const code = await runScaffold(
        {
          dir: project,
          template: 'chat',
          name: 'thinking-room',
          effectiveTemplate: applyDepsMode(TEMPLATES.chat, 'npm', { version: '1.2.3' }),
        },
        io,
      );
      const elapsedMs = performance.now() - started;

      expect(code).toBe(0);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(treeBytes(project)).toBeLessThan(750_000);
      const generated = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
        name: string;
        devDependencies: Record<string, string>;
      };
      expect(generated.name).toBe('thinking-room');
      expect(generated.devDependencies['@pyric/cli']).toBe('^1.2.3');
      expect(generated.devDependencies.pyric).toBe('^1.2.3');
      const readme = readFileSync(join(project, 'README.md'), 'utf8');
      expect(readme).toContain('# thinking-room');
      expect(readme).toContain('PYRIC_AI_MODEL=qwen3:4b \\');
      expect(readme).toContain('Do not put `&&` before `npm run dev`');
      expect(readme).toContain('## Runtime status');
      expect(readFileSync(join(project, 'index.html'), 'utf8')).toContain('<title>thinking-room');
      expect(readFileSync(join(project, '.gitignore'), 'utf8')).toContain('node_modules/');
      expect(readdirSync(project)).not.toContain('scaffold.json');
      expect(readdirSync(project)).not.toContain('bun.lock');
      const viteConfig = readFileSync(join(project, 'vite.config.ts'), 'utf8');
      expect(viteConfig).not.toContain('node_modules/');
      expect(viteConfig).toContain('pyric()');
      expect(viteConfig).not.toContain('loadEnv');
      expect(viteConfig).not.toContain('bridge: true');
      expect(viteConfig).not.toContain('modelMap');
      const functions = readFileSync(join(project, 'functions/index.js'), 'utf8');
      expect(functions).toContain('snapshot.data()?.firstSeenAt');
      expect(functions).not.toContain("snapshot.get('firstSeenAt')");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps every top-level chat source entry classified by the manifest', () => {
    const root = fileURLToPath(new URL('../templates/chat/', import.meta.url));
    const manifest = JSON.parse(readFileSync(join(root, 'scaffold.json'), 'utf8')) as {
      include: string[];
    };
    const runtimeEntries = new Set(['.agents', '.codex', '.npmignore', '.pyric', 'dist', 'node_modules']);
    expect(readdirSync(root).filter((entry) => !runtimeEntries.has(entry)).sort()).toEqual(
      [...manifest.include, 'package.json', 'scaffold.json'].sort(),
    );
  });

  it('rejects an asset manifest entry that escapes the template root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'create-pyric-unsafe-'));
    const root = join(parent, 'chat');
    try {
      mkdirSync(root);
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ scripts: {}, dependencies: {}, devDependencies: {} }),
      );
      writeFileSync(join(root, 'scaffold.json'), JSON.stringify({ include: ['../outside.txt'] }));
      writeFileSync(join(parent, 'outside.txt'), 'not part of the template');
      expect(() => loadAssetTemplate('chat', root)).toThrow('unsafe include');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects symlinks instead of copying outside the source tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'create-pyric-symlink-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ scripts: {}, dependencies: {}, devDependencies: {} }),
      );
      writeFileSync(join(root, 'target.txt'), 'target');
      writeFileSync(join(root, 'scaffold.json'), JSON.stringify({ include: ['linked.txt'] }));
      try {
        symlinkSync(join(root, 'target.txt'), join(root, 'linked.txt'));
      } catch {
        return; // Windows may not grant symlink creation to an unprivileged test process.
      }
      expect(() => loadAssetTemplate('chat', root)).toThrow('contains a symlink');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
