import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findEdgeRuntimeFiles } from '../../../src/next/edge-runtime.js';
import { withPyric } from '../../../src/next/index.js';
import { markRegisterActive } from '../../../src/register/activation.js';

/** The register's activation mark (`src/register/activation.ts`). */
const REGISTER_ACTIVE = Symbol.for('pyric.register.active');

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
    delete (globalThis as Record<symbol, unknown>)[REGISTER_ACTIVE];
    rmSync(root, { recursive: true, force: true });
  });

  it('names files that export runtime = edge or config = { runtime: edge }, relative to the project root', () => {
    write('app/api/ping/route.ts', "export const runtime = 'edge';\nexport function GET() { return new Response('ok'); }\n");
    write('src/pages/api/hello.ts', 'export const runtime = "experimental-edge"\n');
    write('pages/api/items.ts', "export const config = {\n  api: { bodyParser: false },\n  runtime: 'edge',\n};\n");
    write('src/pages/feed.tsx', 'export const config = { runtime: "experimental-edge" };\n');
    write('app/page.tsx', 'export default function Page() { return null; }\n');
    write('app/api/node/route.ts', "export const runtime = 'nodejs';\n");
    write('pages/api/node.ts', "export const config = { runtime: 'nodejs' };\n");
    expect(findEdgeRuntimeFiles(root).sort()).toEqual([
      'app/api/ping/route.ts',
      'pages/api/items.ts',
      'src/pages/api/hello.ts',
      'src/pages/feed.tsx',
    ]);
  });

  it('names a middleware file unless it opts into the Node.js runtime via runtime = nodejs or config = { runtime: nodejs }', () => {
    write('middleware.ts', 'export function middleware() {}\n');
    expect(findEdgeRuntimeFiles(root)).toEqual(['middleware.ts']);

    write('middleware.ts', "export const runtime = 'nodejs';\nexport function middleware() {}\n");
    expect(findEdgeRuntimeFiles(root)).toEqual([]);

    write('middleware.ts', "export const config = {\n  matcher: ['/items/:path*'],\n  runtime: 'nodejs',\n};\nexport function middleware() {}\n");
    expect(findEdgeRuntimeFiles(root)).toEqual([]);

    write('src/middleware.ts', 'export function middleware() {}\n');
    expect(findEdgeRuntimeFiles(root)).toEqual(['src/middleware.ts']);

    write('src/middleware.ts', 'export const runtime = "nodejs";\nexport function middleware() {}\n');
    expect(findEdgeRuntimeFiles(root)).toEqual([]);
  });

  it('treats Next.js 16 proxy.ts and src/proxy.ts as Node.js by default unless explicitly set to edge', () => {
    write('proxy.ts', 'export function proxy() { return Response.next(); }\n');
    write('src/proxy.ts', 'export function proxy() { return Response.next(); }\n');
    expect(findEdgeRuntimeFiles(root)).toEqual([]);

    write('proxy.ts', "export const runtime = 'edge';\nexport function proxy() {}\n");
    write('src/proxy.ts', "export const config = { runtime: 'edge' };\nexport function proxy() {}\n");
    expect(findEdgeRuntimeFiles(root).sort()).toEqual(['proxy.ts', 'src/proxy.ts']);
  });

  it('ignores commented-out runtime declarations while preserving URLs and globs inside string and template literals', () => {
    write(
      'app/api/commented/route.ts',
      "// export const runtime = 'edge';\n/* export const config = { runtime: 'edge' }; */\nexport function GET() { return new Response('ok'); }\n",
    );
    write(
      'app/api/active/route.ts',
      "const endpoint = 'https://example.com//v1/*not-a-comment';\nconst tpl = `https://example.com//items`;\nexport const runtime = 'edge';\n",
    );
    write(
      'middleware.ts',
      "// TODO: export const runtime = 'nodejs'\n/* runtime: 'nodejs' */\nexport function middleware() {}\n",
    );
    expect(findEdgeRuntimeFiles(root).sort()).toEqual(['app/api/active/route.ts', 'middleware.ts']);

    write(
      'middleware.ts',
      "const origin = 'https://example.com//auth';\nexport const config = {\n  matcher: ['/items/*', '*/admin'],\n  runtime: 'nodejs',\n};\n",
    );
    expect(findEdgeRuntimeFiles(root)).toEqual(['app/api/active/route.ts']);
  });

  it('skips node_modules and returns nothing for a missing project', () => {
    write('node_modules/pkg/index.js', "export const runtime = 'edge';\n");
    expect(findEdgeRuntimeFiles(root)).toEqual([]);
    expect(findEdgeRuntimeFiles(join(root, 'absent'))).toEqual([]);
  });

  it('detects named export clauses, re-exported segment configs, multi-declarator exports, and typed config annotations', () => {
    write('app/api/named/route.ts', "const runtime = 'edge';\nexport { runtime };\n");
    write('lib/segment-config.ts', "export const runtime = 'edge';\n");
    write('app/api/reexport/route.ts', "export { runtime } from '../../../lib/segment-config';\n");
    write('app/api/multi/route.ts', "export const dynamic = 'force-dynamic', runtime = 'edge';\n");
    write('pages/api/typed-edge.ts', "export const config: { runtime: 'edge' } = { runtime: 'edge' };\n");
    write(
      'middleware.ts',
      "export const config: { runtime: 'nodejs' } = { runtime: 'nodejs' };\nexport function middleware() {}\n",
    );

    expect(findEdgeRuntimeFiles(root).sort()).toEqual([
      'app/api/multi/route.ts',
      'app/api/named/route.ts',
      'app/api/reexport/route.ts',
      'pages/api/typed-edge.ts',
    ]);
  });

  it('resolves JSX apostrophes, JSX closing-tag comments, imported bindings, barrel star re-exports, tsconfig paths/extends, generics, and parenthesized config values', () => {
    write(
      'tsconfig.base.json',
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./*'] },
        },
      }),
    );
    write(
      'tsconfig.json',
      JSON.stringify({
        extends: './tsconfig.base.json',
      }),
    );
    write('lib/constants.ts', "export const EDGE_RUNTIME = 'edge' as const;\nexport const NODE_RUNTIME = 'nodejs' as const;\n");
    write('lib/index.ts', "export * from './constants';\n");
    write('lib/edge-config.ts', "export const runtime = 'edge';\n");

    write(
      'app/items/page.tsx',
      "export default function ItemsPage() { return <p>Org's items</p> }\nexport const runtime = 'edge';\n",
    );
    write(
      'app/docs/page.tsx',
      "export default function DocsPage() { return <div>Docs</div> } // view\nexport const runtime = 'edge';\n",
    );
    write(
      'app/api/imported/route.ts',
      "import { EDGE_RUNTIME } from '../../../lib/constants';\nexport const runtime = EDGE_RUNTIME;\n",
    );
    write(
      'app/api/barrel/route.ts',
      "export { EDGE_RUNTIME as runtime } from '../../../lib';\n",
    );
    write(
      'app/api/aliased/route.ts',
      "export { runtime } from '@/lib/edge-config';\n",
    );
    write(
      'app/api/generics/route.ts',
      "export const store = new Map<string, string>(), runtime = 'edge';\n",
    );
    write(
      'pages/api/paren-config.ts',
      "export const config = ({ runtime: ('edge') });\n",
    );
    write(
      'middleware.ts',
      "import { NODE_RUNTIME } from '@/lib/constants';\nexport const runtime = NODE_RUNTIME;\nexport function middleware() {}\n",
    );

    expect(findEdgeRuntimeFiles(root).sort()).toEqual([
      'app/api/aliased/route.ts',
      'app/api/barrel/route.ts',
      'app/api/generics/route.ts',
      'app/api/imported/route.ts',
      'app/docs/page.tsx',
      'app/items/page.tsx',
      'pages/api/paren-config.ts',
    ]);
  });

  it('resolves object member access, renamed destructuring, TypeScript enums, .cts/.cjs modules, workspace node_modules, #imports, and ancestor tsconfig paths', () => {
    const monoRoot = mkdtempSync(join(tmpdir(), 'pyric-edge-mono-'));
    try {
      mkdirSync(join(monoRoot, 'apps/web'), { recursive: true });
      writeFileSync(
        join(monoRoot, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@shared/*': ['./packages/shared/*'] },
          },
        }),
      );
      mkdirSync(join(monoRoot, 'packages/shared'), { recursive: true });
      writeFileSync(join(monoRoot, 'packages/shared/edge.ts'), "export const runtime = 'edge';\n");

      const webRoot = join(monoRoot, 'apps/web');
      writeFileSync(
        join(webRoot, 'package.json'),
        JSON.stringify({
          name: 'web-app',
          imports: { '#edge': './lib/hash-edge.js' },
        }),
      );
      mkdirSync(join(webRoot, 'lib'), { recursive: true });
      writeFileSync(join(webRoot, 'lib/hash-edge.js'), "export const runtime = 'edge';\n");
      writeFileSync(join(webRoot, 'lib/cfg.cts'), "export const CTS_EDGE = 'edge';\n");
      mkdirSync(join(webRoot, 'node_modules/@acme/edge-config'), { recursive: true });
      writeFileSync(
        join(webRoot, 'node_modules/@acme/edge-config/package.json'),
        JSON.stringify({ name: '@acme/edge-config', main: './index.ts' }),
      );
      writeFileSync(join(webRoot, 'node_modules/@acme/edge-config/index.ts'), "export const runtime = 'edge';\n");

      const writeWeb = (rel: string, text: string) => {
        const full = join(webRoot, rel);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, text);
      };

      writeWeb('app/api/ws/route.ts', "export { runtime } from '@acme/edge-config';\n");
      writeWeb('app/api/imp/route.js', "export { runtime } from '#edge';\n");
      writeWeb('app/api/shared/route.ts', "export { runtime } from '@shared/edge';\n");
      writeWeb(
        'app/api/obj/route.ts',
        "const RUNTIMES = { EDGE: 'edge', NODE: 'nodejs' } as const;\nexport const runtime = RUNTIMES.EDGE;\n",
      );
      writeWeb(
        'app/api/destruct/route.ts',
        "const RUNTIMES = { EDGE: 'edge' } as const;\nconst { EDGE: runtime } = RUNTIMES;\nexport { runtime };\n",
      );
      writeWeb(
        'app/api/enum/route.ts',
        "enum Runtime { Edge = 'edge', Node = 'nodejs' }\nexport const runtime = Runtime.Edge;\n",
      );
      writeWeb('app/api/cts/route.cts', "export const runtime = 'edge';\n");
      writeWeb('app/api/from-cts/route.ts', "import { CTS_EDGE } from '../../../lib/cfg.cjs';\nexport const runtime = CTS_EDGE;\n");
      writeWeb(
        'middleware.cts',
        "const RUNTIMES = { EDGE: 'edge', NODE: 'nodejs' } as const;\nexport const runtime = RUNTIMES.NODE;\nexport function middleware() {}\n",
      );

      expect(findEdgeRuntimeFiles(webRoot).sort()).toEqual([
        'app/api/cts/route.cts',
        'app/api/destruct/route.ts',
        'app/api/enum/route.ts',
        'app/api/from-cts/route.ts',
        'app/api/imp/route.js',
        'app/api/obj/route.ts',
        'app/api/shared/route.ts',
        'app/api/ws/route.ts',
      ]);
    } finally {
      rmSync(monoRoot, { recursive: true, force: true });
    }
  });

  it('fails closed on unresolved re-exports, cyclic or non-literal runtime declarations, syntax errors, JSX in .ts, and unreadable middleware', () => {
    write('app/api/missing/route.ts', "export { runtime } from './missing-segment-config';\n");
    write('app/api/missing-star/route.ts', "export * from './missing-barrel';\n");
    write('app/api/cycle-a/route.ts', "export { runtime } from '../cycle-b/route';\n");
    write('app/api/cycle-b/route.ts', "export { runtime } from '../cycle-a/route';\n");
    write('app/api/concat/route.ts', "export const runtime = 'ed' + 'ge';\n");
    write('app/api/syntax/route.ts', "/* unterminated comment\nexport const runtime = 'edge';\n");
    write(
      'app/api/jsx-in-ts/route.ts',
      "export default function H() { return <div title=\"a\">It's here</div> }\nexport const runtime = 'edge';\n",
    );
    write('app/api/mutable-let/route.ts', "let runtime = 'nodejs';\nruntime = 'edge';\nexport { runtime };\n");
    write(
      'app/api/mutated-obj/route.ts',
      "const config: { runtime: string } = { runtime: 'nodejs' };\nconfig.runtime = 'edge';\nexport { config };\n",
    );
    mkdirSync(join(root, 'middleware.ts'), { recursive: true });

    expect(findEdgeRuntimeFiles(root).sort()).toEqual([
      'app/api/concat/route.ts',
      'app/api/cycle-a/route.ts',
      'app/api/cycle-b/route.ts',
      'app/api/jsx-in-ts/route.ts',
      'app/api/missing-star/route.ts',
      'app/api/missing/route.ts',
      'app/api/mutable-let/route.ts',
      'app/api/mutated-obj/route.ts',
      'app/api/syntax/route.ts',
      'middleware.ts',
    ]);
  });
});

describe('withPyric Edge runtime stop (PYRIC_EDGE_RUNTIME_UNSUPPORTED)', () => {
  const savedCwd = process.cwd();
  const savedSandbox = process.env.PYRIC_SANDBOX;
  const savedAllowEdge = process.env.PYRIC_ALLOW_UNSWAPPED_EDGE;
  let root: string;
  let warnings: string[];
  const originalWarn = console.warn;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pyric-edge-stop-'));
    mkdirSync(join(root, 'app/api/ping'), { recursive: true });
    writeFileSync(join(root, 'app/api/ping/route.ts'), "export const runtime = 'edge';\n");
    writeFileSync(join(root, 'next.config.mjs'), 'export default {};\n');
    process.chdir(root);
    process.env.PYRIC_SANDBOX = 'remote:http://127.0.0.1:4000';
    delete process.env.PYRIC_ALLOW_UNSWAPPED_EDGE;
    markRegisterActive();
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
    if (savedAllowEdge === undefined) delete process.env.PYRIC_ALLOW_UNSWAPPED_EDGE;
    else process.env.PYRIC_ALLOW_UNSWAPPED_EDGE = savedAllowEdge;
    delete (globalThis as Record<symbol, unknown>)[REGISTER_ACTIVE];
  });

  it('throws PYRIC_EDGE_RUNTIME_UNSUPPORTED in the development server phase and names the Edge file', async () => {
    const wrapped = withPyric({}) as (phase: string, defaults: Record<string, any>) => Promise<Record<string, any>>;
    let caught: (Error & { code?: string }) | undefined;
    try {
      await wrapped('phase-development-server', {});
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe('PYRIC_EDGE_RUNTIME_UNSUPPORTED');
    expect(caught!.message).toContain('app/api/ping/route.ts');
    expect(caught!.message).toContain("export const runtime = 'nodejs'");
    expect(caught!.message).toContain('PYRIC_ALLOW_UNSWAPPED_EDGE=1');
    expect(warnings).toEqual([]);
  });

  it('warns instead of throwing when PYRIC_ALLOW_UNSWAPPED_EDGE=1 is set', async () => {
    process.env.PYRIC_ALLOW_UNSWAPPED_EDGE = '1';
    const wrapped = withPyric({}) as (phase: string, defaults: Record<string, any>) => Promise<Record<string, any>>;
    const config = await wrapped('phase-development-server', {});
    expect(config.serverExternalPackages).toContain('firebase');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('app/api/ping/route.ts');
    expect(warnings[0]).toContain('Edge');
  });

  it('does not throw or warn in a production build phase', async () => {
    const wrapped = withPyric({}) as (phase: string, defaults: Record<string, any>) => Promise<Record<string, any>>;
    await wrapped('phase-production-build', {});
    expect(warnings).toEqual([]);
  });

  it('allows a Next.js 16 proxy.ts in the development server phase without throwing', async () => {
    rmSync(join(root, 'app/api/ping/route.ts'));
    writeFileSync(join(root, 'proxy.ts'), 'export function proxy() { return Response.next(); }\n');
    const wrapped = withPyric({}) as (phase: string, defaults: Record<string, any>) => Promise<Record<string, any>>;
    const config = await wrapped('phase-development-server', {});
    expect(config.serverExternalPackages).toContain('firebase');
    expect(warnings).toEqual([]);
  });
});
