/** `pyric init` v2 — agent-first scaffold engine (pyric-init plan 1.1–1.4).
 *  Real temp dirs; the engine is filesystem-in/filesystem-out, test it as
 *  one. The served-app behavior is the browser gate (step 1.5). */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit, type InitResult } from '../../src/cli/init.js';
import type { ParsedArgs } from '../../src/cli/parse-args.js';

function args(positional: string[] = [], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return { subcommand: 'init', flags: new Map(Object.entries(flags)), positional };
}

function capture() {
  let outBuf = '';
  let errBuf = '';
  return {
    deps: (cwd: string) => ({
      cwd,
      stdout: { write: (s: string) => void (outBuf += s) },
      stderr: { write: (s: string) => void (errBuf += s) },
    }),
    out: () => outBuf,
    err: () => errBuf,
  };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'pyric-init-'));

describe('pyric init v2 — web template (default, Vite)', () => {
  it('scaffolds a Vite app wired to pyric-tools/vite, canonical firebase imports', async () => {
    const dir = tmp();
    const c = capture();
    expect(await runInit(args(), c.deps(dir))).toBe(0);

    for (const f of [
      'index.html',
      'vite.config.ts',
      'tsconfig.json',
      'src/main.ts',
      'src/vite-env.d.ts',
      'firestore.rules',
      'firebase.json',
      'firestore.indexes.json',
      '.env.example',
      'README.md',
      '.gitignore',
      'package.json',
    ]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    // the Vite template has no static `public/` tree
    expect(existsSync(join(dir, 'public'))).toBe(false);

    // app code uses canonical firebase/* imports — pyric never leaks in
    const main = readFileSync(join(dir, 'src/main.ts'), 'utf8');
    expect(main).toContain("from 'firebase/app'");
    expect(main).toContain('initializeApp(');
    expect(main).not.toContain("from 'pyric");

    // the swap lives in vite.config, not the app
    const viteConfig = readFileSync(join(dir, 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain("from 'pyric-tools/vite'");
    expect(viteConfig).toContain('pyricSandbox(');

    // hosting serves Vite's build output
    const fb = JSON.parse(readFileSync(join(dir, 'firebase.json'), 'utf8'));
    expect(fb.hosting.public).toBe('dist');
    expect(fb.hosting.rewrites[0].source).toBe('**');

    // owner-based rules, not open
    const rules = readFileSync(join(dir, 'firestore.rules'), 'utf8');
    expect(rules).toContain('request.auth != null');
    expect(rules).not.toMatch(/allow write: if true/);

    // one toolchain: vite dev (sandbox) + vite build (real firebase ships day one)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.type).toBe('module');
    expect(pkg.dependencies.firebase).toMatch(/^\^/);
    expect(pkg.devDependencies['pyric-tools']).toBeDefined();
    expect(pkg.devDependencies.vite).toMatch(/^\^/);
    expect(pkg.scripts.dev).toBe('vite');
    expect(pkg.scripts.build).toBe('vite build');

    expect(c.out()).toContain('Next steps:');
  });

  it('rerun is idempotent: everything skipped, nothing rewritten', async () => {
    const dir = tmp();
    await runInit(args(), capture().deps(dir));
    const marker = '/* user edit */';
    writeFileSync(join(dir, 'src/main.ts'), marker);

    const c = capture();
    expect(await runInit(args([], { json: true }), c.deps(dir))).toBe(0);
    const result = JSON.parse(c.out()) as InitResult;
    expect(result.created).toEqual([]);
    expect(result.skipped).toContain('src/main.ts');
    expect(result.skipped).toContain('package.json'); // unchanged merge
    expect(readFileSync(join(dir, 'src/main.ts'), 'utf8')).toBe(marker); // untouched
  });

  it('--force overwrites scaffold files but never package.json values', async () => {
    const dir = tmp();
    await runInit(args(), capture().deps(dir));
    writeFileSync(join(dir, 'src/main.ts'), 'broken');
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.scripts.dev = 'my custom dev';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const c = capture();
    expect(await runInit(args([], { force: true, json: true }), c.deps(dir))).toBe(0);
    const result = JSON.parse(c.out()) as InitResult;
    expect(result.created).toContain('src/main.ts');
    expect(readFileSync(join(dir, 'src/main.ts'), 'utf8')).not.toBe('broken');
    // user's script kept, surfaced as a conflict
    expect(JSON.parse(readFileSync(pkgPath, 'utf8')).scripts.dev).toBe('my custom dev');
    expect(result.conflicts.map((x) => x.key)).toContain('scripts.dev');
  });

  it('merges into an existing package.json (adds missing, keeps order/indent)', async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'mine', type: 'module', scripts: { test: 'bun test' } }, null, '\t'),
    );
    const c = capture();
    expect(await runInit(args([], { json: true }), c.deps(dir))).toBe(0);
    const result = JSON.parse(c.out()) as InitResult;
    expect(result.merged).toEqual(['package.json']);
    const raw = readFileSync(join(dir, 'package.json'), 'utf8');
    expect(raw).toContain('\t"scripts"'); // indent preserved
    const pkg = JSON.parse(raw);
    expect(pkg.name).toBe('mine'); // never overwritten
    expect(pkg.scripts.test).toBe('bun test');
    expect(pkg.scripts.dev).toBe('vite');
  });
});

describe('pyric init v2 — web template ↔ example dogfood stay in sync', () => {
  // The in-repo example (examples/vite-sandbox-app) is the browser-verified
  // reference. These name-independent files must be byte-identical to what the
  // web template scaffolds, so the two can never drift apart.
  const EXAMPLE_DIR = fileURLToPath(new URL('../../../../examples/vite-sandbox-app', import.meta.url));
  // NOTE: `.env.example` is intentionally excluded — the repo's root .gitignore
  // ignores `.env.example`, so the in-repo example can't commit one (the scaffold
  // still generates it for end users). Everything else must match byte-for-byte.
  const SYNCED = [
    'vite.config.ts',
    'src/main.ts',
    'src/vite-env.d.ts',
    'tsconfig.json',
    'firebase.json',
    'firestore.indexes.json',
    'firestore.rules',
    '.gitignore',
  ];

  it('scaffolded web files are byte-identical to examples/vite-sandbox-app', async () => {
    const dir = tmp();
    await runInit(args(), capture().deps(dir));
    for (const f of SYNCED) {
      const scaffolded = readFileSync(join(dir, f), 'utf8');
      const example = readFileSync(join(EXAMPLE_DIR, f), 'utf8');
      // include the filename so a mismatch names the drifted file
      expect([f, scaffolded]).toEqual([f, example]);
    }
    // the web template has no seed.json — seeding is a plugin (M2) feature, not
    // a scaffolded file. (The `static` template keeps seed.json for pyric dev.)
    expect(existsSync(join(dir, 'seed.json'))).toBe(false);
  });
});

describe('pyric init v2 — static template (serve-era, no bundler)', () => {
  it('scaffolds the static public/ app served by pyric dev', async () => {
    const dir = tmp();
    const c = capture();
    expect(await runInit(args([], { template: 'static', json: true }), c.deps(dir))).toBe(0);
    const result = JSON.parse(c.out()) as InitResult;
    expect(result.template).toBe('static');

    for (const f of ['public/index.html', 'public/app.js', 'seed.json', 'firebase.json']) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    // no Vite scaffold
    expect(existsSync(join(dir, 'vite.config.ts'))).toBe(false);

    const app = readFileSync(join(dir, 'public/app.js'), 'utf8');
    expect(app).toContain("from 'firebase/app'");
    expect(app).not.toContain("from 'pyric");

    const fb = JSON.parse(readFileSync(join(dir, 'firebase.json'), 'utf8'));
    expect(fb.hosting.public).toBe('public'); // not a build output

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts.dev).toContain('pyric dev');
    expect(pkg.scripts['dev:agent']).toContain('--bridge');

    // seed shape matches the --seed contract (path → fields)
    const seed = JSON.parse(readFileSync(join(dir, 'seed.json'), 'utf8'));
    expect(Object.keys(seed)[0]).toMatch(/^posts\//);
  });
});

describe('pyric init v2 — CLI surface', () => {
  it('[dir] positional creates the directory; --name overrides', async () => {
    const root = tmp();
    const c = capture();
    expect(await runInit(args(['myapp'], { name: 'custom-name', json: true }), c.deps(root))).toBe(0);
    const result = JSON.parse(c.out()) as InitResult;
    expect(result.dir).toBe(join(root, 'myapp'));
    expect(existsSync(join(root, 'myapp', 'index.html'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, 'myapp', 'package.json'), 'utf8'));
    expect(pkg.name).toBe('custom-name');
    expect(readFileSync(join(root, 'myapp', 'README.md'), 'utf8')).toContain('# custom-name');
  });

  it('--json emits ONE parseable line on stdout; human report on stderr', async () => {
    const dir = tmp();
    const c = capture();
    expect(await runInit(args([], { json: true }), c.deps(dir))).toBe(0);
    const lines = c.out().trim().split('\n');
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0]!) as InitResult;
    expect(result.template).toBe('web');
    expect(result.nextSteps[0]).toBe('bun install');
    expect(result.created.length).toBeGreaterThan(0);
    expect(c.err()).toContain('Next steps:'); // human report relocated
  });

  it('the parser quirk --force <dir> is reclaimed as the positional', async () => {
    const root = tmp();
    const c = capture();
    // parse-args binds `--force myapp` as flags.force='myapp'
    const parsed = args([], { force: 'myapp', json: true });
    expect(await runInit(parsed, c.deps(root))).toBe(0);
    expect((JSON.parse(c.out()) as InitResult).dir).toBe(join(root, 'myapp'));
  });

  it('unknown template → usage error 1, nothing written', async () => {
    const dir = tmp();
    const c = capture();
    expect(await runInit(args([], { template: 'angularjs' }), c.deps(dir))).toBe(1);
    expect(c.err()).toContain("unknown template 'angularjs'");
    expect(c.err()).toContain('web|node|static');
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
  });

  it('--template node keeps the script-style scaffold', async () => {
    const dir = tmp();
    const c = capture();
    expect(await runInit(args([], { template: 'node', json: true }), c.deps(dir))).toBe(0);
    const result = JSON.parse(c.out()) as InitResult;
    expect(result.template).toBe('node');
    expect(existsSync(join(dir, 'src/app.ts'))).toBe(true);
    expect(existsSync(join(dir, 'public'))).toBe(false);
    // graduation is the PYRIC_TARGET env swap, not a hand edit
    const appTs = readFileSync(join(dir, 'src/app.ts'), 'utf8');
    expect(appTs).toContain('process.env.PYRIC_TARGET');
    expect(existsSync(join(dir, '.env.example'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies.pyric).toBe('*');
    expect(pkg.scripts.start).toBe('bun src/app.ts');
  });
});
