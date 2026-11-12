// @pyric/rules on its own (#1521, D11). A project whose only dependency is
// @pyric/rules unit-tests its Firestore, Storage and Realtime Database rules
// with `node --test`, as a user would, from the packed tarball. The install
// must not pull in the rest of pyric, the Firebase SDKs or TypeScript, and
// the package's root entry must stay bundleable for a browser: no module it
// imports, through its own files and its dependencies, imports a Node
// built-in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenario } from '../driver.ts';

const PACKAGE = '@pyric/rules';
const NOT_INSTALLED = ['pyric', 'firebase', 'firebase-admin', 'typescript'];
/** Everything the install may hold: the package and its two dependencies. */
const INSTALLED = ['@pyric/rules', 'ohm-js', 'zod'];
/** A literal dynamic import, which the resolve hook sees only when it runs. */
const DYNAMIC_IMPORT = /\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const USER_TESTS = 12;

/** A test that expects ALLOW for a request the rules deny: it must fail. */
const WRONG_EXPECTATION = `import { test } from 'node:test';
import { assertCase, firestoreRules } from '@pyric/rules';
import { readFileSync } from 'node:fs';

const rules = firestoreRules(readFileSync('firestore.rules', 'utf8'));
test('another user reads the note', () => assertCase(rules, {
  description: 'another user reads the note',
  expectation: 'ALLOW',
  method: 'get',
  path: 'notes/n1',
  auth: { uid: 'bob' },
  resource: { owner: 'alice' },
}));
`;

/**
 * Imports the root entry with a resolve hook that sees every import
 * declaration Node resolves, in @pyric/rules and in its dependencies, and
 * prints each as `{ specifier, url, parent }`. A Node built-in resolves to a
 * `node:` URL. `process.getBuiltinModule`, which the package uses for its
 * file-reading helpers, is a call, not an import, so it is not listed.
 */
const IMPORT_GRAPH = `import { registerHooks } from 'node:module';
const imports = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    imports.push({ specifier, url: resolved.url, parent: context.parentURL ?? '' });
    return resolved;
  },
});
await import('${PACKAGE}');
console.log(JSON.stringify(imports));
`;

interface LockEntry {
  resolved?: string;
  integrity?: string;
  link?: boolean;
}

interface ResolvedImport {
  specifier: string;
  url: string;
  parent: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** The package name a lockfile path installs: `node_modules/a/node_modules/@s/b` is `@s/b`. */
function lockName(path: string): string {
  const marker = 'node_modules/';
  return path.slice(path.lastIndexOf(marker) + marker.length);
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0] ?? specifier);
}

/** The literal dynamic imports of a built-in in `file`, as `<specifier> in <file>`. */
function lazyBuiltinImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(DYNAMIC_IMPORT)]
    .map((match) => match[1] ?? '')
    .filter(isBuiltin)
    .map((specifier) => `import('${specifier}') in ${file}`);
}

function sha512(file: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
}

export default scenario(async (app) => {
  const installed = join(app.dir, 'node_modules', PACKAGE);
  const lockfile = () => readJson<{ packages: Record<string, LockEntry> }>(join(app.dir, 'package-lock.json'));

  await app.step('the installed @pyric/rules came from the packed tarball', () => {
    const manifest = readJson<{ devDependencies: Record<string, string> }>(join(app.dir, 'package.json'));
    const spec = manifest.devDependencies[PACKAGE] ?? '';
    assert.match(spec, /^file:.*\.tgz$/, `the runner points ${PACKAGE} at a tarball, got ${spec}`);
    const tarball = spec.slice('file:'.length);
    const entry = lockfile().packages[`node_modules/${PACKAGE}`];
    assert.ok(entry, `package-lock.json installs ${PACKAGE}`);
    assert.notEqual(entry.link, true, `${PACKAGE} is installed, not linked to a workspace`);
    assert.equal(basename(entry.resolved ?? ''), basename(tarball), `${PACKAGE} resolved from ${entry.resolved}`);
    assert.equal(entry.integrity, sha512(tarball), `${PACKAGE} holds this run's tarball`);
    assert.equal(lstatSync(installed).isSymbolicLink(), false, `node_modules/${PACKAGE} is a directory, not a link`);
  });

  await app.step('the install holds only @pyric/rules, ohm-js and zod', () => {
    const names = Object.keys(lockfile().packages).filter((path) => path !== '').map(lockName);
    assert.deepEqual([...new Set(names)].sort(), INSTALLED);
    for (const name of NOT_INSTALLED) {
      assert.equal(existsSync(join(app.dir, 'node_modules', name)), false, `node_modules/${name} exists`);
    }
  });

  await app.step('the user\'s rules tests pass under node --test', async () => {
    const { code, output } = await app.command('node', ['--test', '--test-reporter=tap'], { timeoutMs: 60_000 });
    assert.equal(code, 0, output);
    assert.match(output, new RegExp(`^# pass ${USER_TESTS}$`, 'm'), output);
    assert.match(output, /^# fail 0$/m, output);
  });

  await app.step('a test with the wrong expectation fails with the rules\' reason', async () => {
    app.writeFile('wrong-expectation.mjs', WRONG_EXPECTATION);
    const { code, output } = await app.command('node', ['--test', '--test-reporter=tap', 'wrong-expectation.mjs'], { timeoutMs: 60_000 });
    assert.notEqual(code, 0, output);
    assert.match(output, /^# fail 1$/m, output);
    assert.match(output, /RulesAssertionError/, output);
  });

  await app.step('no module the root entry reaches imports a Node built-in', async () => {
    const { code, output } = await app.command('node', ['--input-type=module', '-e', IMPORT_GRAPH], { timeoutMs: 60_000 });
    assert.equal(code, 0, output);
    const imports = JSON.parse(output.trim().split('\n').at(-1) ?? '[]') as ResolvedImport[];
    const fromInstall = imports.filter((entry) => entry.parent.includes('/node_modules/'));
    const reached = new Set(fromInstall.map((entry) => entry.url));
    assert.ok(reached.size > 50, `the hook saw ${reached.size} modules`);
    for (const dependency of ['ohm-js', 'zod']) {
      assert.ok([...reached].some((url) => url.includes(`/node_modules/${dependency}/`)), `the graph reaches ${dependency}`);
    }
    const builtins = fromInstall.filter((entry) => entry.url.startsWith('node:'));
    assert.deepEqual(builtins.map((entry) => `${entry.specifier} imported by ${entry.parent}`), []);
    // A lazy import('node:...') resolves only when its code runs, so the hook
    // misses it. Every file the graph reached is scanned for one instead.
    const installedUrls = new Set(imports.map((entry) => entry.url).filter((url) => url.startsWith('file:') && url.includes('/node_modules/')));
    const files = [...installedUrls].map((url) => fileURLToPath(url));
    assert.deepEqual(files.flatMap(lazyBuiltinImports), []);
  });
});
