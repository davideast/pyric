import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findEdgeRuntimeFiles } from '../../../src/next/edge-runtime.js';
import { withPyric } from '../../../src/next/index.js';

describe('Edge runtime detection', () => {
  let root: string;

  function write(relative: string, content: string): void {
    const full = join(root, relative);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pyric-edge-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('names files that export runtime = edge, relative to the project root', () => {
    write('app/api/ping/route.ts', "export const runtime = 'edge';\nexport function GET() { return new Response('ok'); }\n");
    write('src/pages/api/hello.ts', 'export const runtime = "edge"\n');
    write('app/page.tsx', 'export default function Page() { return null; }\n');
    write('app/api/node/route.ts', "export const runtime = 'nodejs';\n");
    expect(findEdgeRuntimeFiles(root).sort()).toEqual(['app/api/ping/route.ts', 'src/pages/api/hello.ts']);
  });

  it('names a middleware file unless it opts into the Node.js runtime', () => {
    write('middleware.ts', 'export function middleware() {}\n');
    expect(findEdgeRuntimeFiles(root)).toEqual(['middleware.ts']);
    write('middleware.ts', "export const config = { runtime: 'nodejs' };\nexport function middleware() {}\n");
    expect(findEdgeRuntimeFiles(root)).toEqual([]);
  });

  it('skips node_modules and returns nothing for a missing project', () => {
    write('node_modules/pkg/index.js', "export const runtime = 'edge';\n");
    expect(findEdgeRuntimeFiles(root)).toEqual([]);
    expect(findEdgeRuntimeFiles(join(root, 'absent'))).toEqual([]);
  });
});

describe('withPyric Edge runtime warning', () => {
  const savedCwd = process.cwd();
  const savedSandbox = process.env.PYRIC_SANDBOX;
  let root: string;
  let warnings: string[];
  const originalWarn = console.warn;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pyric-edge-warn-'));
    mkdirSync(join(root, 'app/api/ping'), { recursive: true });
    writeFileSync(join(root, 'app/api/ping/route.ts'), "export const runtime = 'edge';\n");
    process.chdir(root);
    process.env.PYRIC_SANDBOX = 'remote:http://127.0.0.1:4000';
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    process.chdir(savedCwd);
    rmSync(root, { recursive: true, force: true });
    if (savedSandbox === undefined) delete process.env.PYRIC_SANDBOX;
    else process.env.PYRIC_SANDBOX = savedSandbox;
  });

  it('warns in the development server phase and names the Edge file', async () => {
    const wrapped = withPyric({}) as (phase: string, defaults: Record<string, any>) => Promise<Record<string, any>>;
    const config = await wrapped('phase-development-server', {});
    expect(config.serverExternalPackages).toContain('firebase');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('app/api/ping/route.ts');
    expect(warnings[0]).toContain('Edge');
  });

  it('does not warn in a production build phase', async () => {
    const wrapped = withPyric({}) as (phase: string, defaults: Record<string, any>) => Promise<Record<string, any>>;
    await wrapped('phase-production-build', {});
    expect(warnings).toEqual([]);
  });
});
