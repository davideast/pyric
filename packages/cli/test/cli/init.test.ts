/** `pyric init` v2 — agent-first scaffold engine (pyric-init plan 1.1–1.4).
 *  Real temp dirs; the engine is filesystem-in/filesystem-out, test it as
 *  one. The served-app behavior is the browser gate (step 1.5). */
import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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
  it('scaffolds a Vite app wired to @pyric/cli/vite, canonical firebase imports', async () => {
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
    expect(viteConfig).toContain("from '@pyric/cli/vite'");
    expect(viteConfig).toContain('pyric(');

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
    expect(pkg.devDependencies['@pyric/cli']).toBeDefined();
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
    // a scaffolded file. The `static` template keeps seed.json for `pyric sandbox`.
    expect(existsSync(join(dir, 'seed.json'))).toBe(false);
  });
});

describe('pyric init v2 — nextjs template ↔ example dogfood stay in sync', () => {
  const EXAMPLE_DIR = fileURLToPath(new URL('../../../../examples/nextjs-sandbox-app', import.meta.url));
  const SYNCED = [
    'next.config.mjs',
    'tsconfig.json',
    'firebase.json',
    'firestore.indexes.json',
    'firestore.rules',
    '.gitignore',
    'src/app/layout.tsx',
    'src/app/page.tsx',
    'src/app/api/status/route.ts',
  ];

  it('scaffolded nextjs files are byte-identical to examples/nextjs-sandbox-app', async () => {
    const dir = tmp();
    await runInit(args([], { template: 'nextjs', name: 'nextjs-sandbox-app' }), capture().deps(dir));
    for (const f of SYNCED) {
      const scaffolded = readFileSync(join(dir, f), 'utf8');
      const example = readFileSync(join(EXAMPLE_DIR, f), 'utf8');
      expect([f, scaffolded]).toEqual([f, example]);
    }
  });
});

describe('pyric init v2 — static template (serve-era, no bundler)', () => {
  it('scaffolds the static public/ app served by pyric sandbox', async () => {
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
    expect(pkg.scripts.dev).toContain('pyric sandbox');
    expect(pkg.scripts['dev:agent']).toContain('--bridge');

    // seed shape matches the --seed contract (path → fields)
    const seed = JSON.parse(readFileSync(join(dir, 'seed.json'), 'utf8'));
    expect(Object.keys(seed)[0]).toMatch(/^posts\//);
  });
});

describe('pyric init v2 — chat template', () => {
  it('scaffolds the full app from the packaged source tree', async () => {
    const dir = tmp();
    const c = capture();
    expect(
      await runInit(
        args([], { template: 'chat', name: 'idea-room', json: true }),
        c.deps(dir),
      ),
    ).toBe(0);
    const result = JSON.parse(c.out()) as InitResult;
    expect(result.template).toBe('chat');
    for (const file of [
      'src/ui/chat/chat-page.tsx',
      'src/firebase-messaging-sw.ts',
      'functions/index.js',
      'firestore.modules.rules',
      'test/preview-component-state.test.js',
    ]) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
    expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).not.toContain('node_modules/');
    expect(existsSync(join(dir, 'bun.lock'))).toBe(false);
    expect(existsSync(join(dir, '.pyric'))).toBe(false);
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
    expect(c.err()).toContain('web|node|static|chat');
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
    // App code stays canonical; the dev command installs the Node swap.
    const appTs = readFileSync(join(dir, 'src/app.ts'), 'utf8');
    expect(appTs).toContain("from 'firebase/app'");
    expect(appTs).toContain("from 'firebase/firestore'");
    expect(appTs).not.toContain("from 'pyric/");
    expect(existsSync(join(dir, '.env.example'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies.firebase).toMatch(/^\^/);
    expect(pkg.dependencies.pyric).toBeUndefined();
    expect(pkg.scripts.dev).toContain('pyric sandbox');
    expect(pkg.scripts.start).toContain('node');
  });

  it('--template node executes its TypeScript entry through the documented Node path', async () => {
    const dir = tmp();
    expect(await runInit(
      args([], { template: 'node', json: true }),
      capture().deps(dir),
    )).toBe(0);
    symlinkSync(join(import.meta.dirname, '../../../../node_modules'), join(dir, 'node_modules'), 'dir');

    const result = spawnSync(
      'node',
      [
        '--import',
        new URL('../../dist/register/index.js', import.meta.url).href,
        '--env-file-if-exists=.env',
        '--experimental-strip-types',
        'src/app.ts',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYRIC_SANDBOX: 'local',
        },
        timeout: 20_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('2 posts:');
  }, 30_000);
});

describe('pyric init v2 — production scripts', () => {
  for (const template of ['web', 'node', 'static', 'chat', 'nextjs'] as const) {
    it(`${template} delegates production deployment to firebase-tools`, async () => {
      const dir = tmp();
      expect(
        await runInit(args([], { template, json: true }), capture().deps(dir)),
      ).toBe(0);

      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(Object.keys(pkg.scripts).some((name) => name.startsWith('deploy'))).toBe(false);
      expect(Object.values(pkg.scripts).some((command) => command.includes('pyric deploy'))).toBe(false);
    });
  }
});

type Template = 'web' | 'node' | 'static';

const contractRoots: string[] = [];

afterEach(() => {
  for (const root of contractRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function generatedFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name !== 'README.md') files.push(relative(root, path));
    }
  };
  visit(root);
  return files.sort();
}

function outputManifest(root: string): Record<string, string> {
  const manifest: Record<string, string> = {};
  for (const path of generatedFiles(root)) {
    manifest[path] = createHash('sha256')
      .update(readFileSync(join(root, path), 'utf8'))
      .digest('hex');
  }
  return manifest;
}

async function scaffoldContract(template: Template): Promise<Record<string, string>> {
  const root = mkdtempSync(join(tmpdir(), `pyric-init-${template}-`));
  contractRoots.push(root);
  const code = await runInit(
    args([], { template, name: 'fixture-app', json: true }),
    capture().deps(root),
  );
  expect(code).toBe(0);
  return outputManifest(root);
}

describe('pyric init output contract', () => {
  it('keeps generated runtime files stable across internal template moves', async () => {
    expect({
      web: await scaffoldContract('web'),
      node: await scaffoldContract('node'),
      static: await scaffoldContract('static'),
    }).toEqual({
      web: {
        '.env.example': '28dfe95f880d2ef18c36d150760286eee88c09054cb5341466f3b22c0f5ff297',
        '.gitignore': '0e07b9adae44651462c122657555ef50ebd683db263aac4681417088e1a321dd',
        'firebase.json': '06ed33d14b46379011c4a805299016f8c03adf5f47994624fde82b794f09ec2b',
        'firestore.indexes.json': '6742255415c36daf631b52f233039190af819205cc41fa58d07dd7d9e180c2b9',
        'firestore.rules': '622374ca45b9bc35f561b377dff02da4c6c583dc1ddcd67cd43b0c69276634bd',
        'index.html': '965e01ca1ebe56b0629f0892ebd41d2e5e88723682d8c5e27f75fb387414189d',
        'package.json': 'f53371163698b81268f95d899c298d84c2f9bbf597909e77af430d71cef8eb10',
        'src/main.ts': '4a28c312cff4db2b3445012b61bf886629ca4c5ea5e3a860d3834e38a9633848',
        'src/vite-env.d.ts': '65996936fbb042915f7b74a200fcdde7e410f32a669b1ab9597cfaa4b0faddb5',
        'tsconfig.json': '5bb892360953642d2644a442a81abbad91e62be2f7fcb646505cc7f33a6bcc08',
        'vite.config.ts': '81505482f0526dc599ee013674544d4ed7ed97cbb5339a44b79663ec8233bd6a',
      },
      node: {
        '.env.example': '20b0fec5308501f75cab4d6026678eefbbbef0001bfabaa17c66d92e67c9d582',
        '.gitignore': '0e07b9adae44651462c122657555ef50ebd683db263aac4681417088e1a321dd',
        'firebase.json': 'e817f89d2f9776ba460ec062be7d40f827b8f910d740cff2522b72232f1cdf5a',
        'firestore.indexes.json': '6742255415c36daf631b52f233039190af819205cc41fa58d07dd7d9e180c2b9',
        'firestore.rules': '9028ecbf9580fee3a04afae28223bad887df81c814d14d2ebe983d30f3a49080',
        'package.json': '848f65db327982161b5543c9364db8fce32849ece24e073c98d8e878147eef69',
        'src/app.ts': '7833e1f764904c9e800cd5728ab0cc68df0347d9b5e6a2084be79f75b35958e5',
        'src/seed.ts': '6f04998f57b899fa7189706553645247f4b354715e899bb8070269b0564c1124',
      },
      static: {
        '.env.example': 'f01f3221a1ec03cbc44664ae0f7518c259018fd3f88dac75fdbb8c233f967ed1',
        '.gitignore': '0e07b9adae44651462c122657555ef50ebd683db263aac4681417088e1a321dd',
        'firebase.json': 'da40b786caed050b30a5bb108c6e369376477e89a8e08e09c105445ef01bd0fd',
        'firestore.indexes.json': '6742255415c36daf631b52f233039190af819205cc41fa58d07dd7d9e180c2b9',
        'firestore.rules': 'd47e64a0acc67a12f4f0c7170b99b4d30bd4011f396ec846f15c77b2bda49550',
        'package.json': 'e15cba94909a39c33422144da4685de4d93faca5f1c093fd050f728100c59713',
        'public/app.js': 'b6dd3753f8385a78518ada97886319201f4f01705d13fef3dfc17a337f595cb9',
        'public/index.html': 'a878cd6b5508217014e966a8f18ffb8be7789118602acc1c8108df244d2bef4e',
        'seed.json': 'd7d4bed7b5b88e4c30720647f630a83769edbb7eb379e5bcec05403e15148935',
      },
    });
  });
});
