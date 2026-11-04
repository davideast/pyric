/**
 * Live rows on the Vite page plane: the four fixed row modules, which reach
 * the installed SDK only once the project's `@pyric/live` opens them; the
 * refusal of every other served specifier; and the refusal of every
 * server-rendered Firebase import.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { SDK_MODULES } from '../../src/serve/firebase-module-swap.js';
import { loadRowModulePackage, type RowModulePackage } from '../../src/serve/vite-live-package.js';
import {
  createViteModuleContext,
  createViteModuleSwap,
  type SwapEnvironment,
  type SwapResolveContext,
} from '../../src/serve/vite-module-swap.js';
import { pyricWithSuppliedRows } from '../../src/serve/vite-supplied-entry.js';
import {
  INSTALLED_SDK_SPECIFIERS,
  OBSERVER_MODULE_ID,
  OBSERVER_SPECIFIER,
  ROW_MODULE_IDS,
  suppliedRows,
  type SuppliedRowsPlane,
} from '../../src/serve/vite-supplied-rows.js';
import { SSR_SWAP_PREFIX } from '../../src/serve/vite-ssr-routing.js';

const STOP_PREFIX = '\0pyric-stop:';
const userImporter = '/some/app/src/main.ts';
const userFirebaseFile = '/app/src/my-firebase.ts';
const rowId = (specifier: string): string => ROW_MODULE_IDS.get(specifier as never) as string;
const refusal = (specifier: string, plane: SuppliedRowsPlane): Error =>
  Object.assign(new Error(`refused ${specifier} on the ${plane}`), { code: 'SUPPLIED_REFUSED' });
const fakePackage: RowModulePackage = {
  root: '/app/node_modules/@pyric/live',
  moduleSource: (id) => `// live module ${JSON.stringify(id)}\n`,
  writeRefusal: (write) => Object.assign(new Error(`refused ${write.action} from ${write.writer}`), { code: 'SUPPLIED_REFUSED' }),
};
const context = createViteModuleContext();
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function openSwap() {
  const rows = suppliedRows(refusal);
  rows.open(fakePackage);
  return createViteModuleSwap(context, { supplied: rows });
}

let imports = 0;

/** The error a module throws when it loads. Each import gets its own URL: bun keeps a module per URL across test files. */
async function thrownBy(source: string | null): Promise<Error & { code?: string }> {
  expect(source).not.toBeNull();
  const unique = `${source as string}\n// supplied-rows ${++imports}\n`;
  try {
    await import(`data:text/javascript;base64,${Buffer.from(unique).toString('base64')}`);
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error(`the module did not throw:\n${source}`);
}

function fakeContext(environment: SwapEnvironment): SwapResolveContext & { passedOn: string[] } {
  const passedOn: string[] = [];
  return {
    passedOn,
    environment,
    resolve: async (source) => {
      passedOn.push(source);
      return { id: `/node_modules/${source}.js` };
    },
  };
}

const runnableSsr = { name: 'ssr', config: { consumer: 'server' }, runner: {} } as SwapEnvironment;
const clientEnvironment: SwapEnvironment = { name: 'client', config: { consumer: 'client' } };
const aliased = (specifier: string) => `${SSR_SWAP_PREFIX}${specifier}`;

/** A project folder with the installed firebase, and `@pyric/live` only when asked. */
function project(withLive: boolean): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-supplied-rows-')));
  scratch.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"app","type":"module"}');
  mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
  if (withLive) symlinkSync(fileURLToPath(new URL('../../../live/', import.meta.url)), join(root, 'node_modules/@pyric/live'));
  return root;
}

describe('live rows, once opened', () => {
  const swap = openSwap();

  it('serve their four specifiers from the fixed row modules, for app and dependency importers', () => {
    expect([...ROW_MODULE_IDS.keys()]).toEqual([...INSTALLED_SDK_SPECIFIERS]);
    for (const specifier of INSTALLED_SDK_SPECIFIERS) {
      expect(rowId(specifier)).toBe(`\0pyric-live:${specifier}`);
      expect(swap.resolveId(specifier, userImporter)).toBe(rowId(specifier));
      expect(swap.resolveId(specifier, '/app/node_modules/a-library/index.js')).toBe(rowId(specifier));
    }
  });

  it("send only a fixed row module's own import of its specifier to the installed SDK", () => {
    expect(swap.resolveId('firebase/firestore', rowId('firebase/firestore'))).toBeNull();
    expect(swap.resolveId('firebase/app', rowId('firebase/firestore'))).toBe(rowId('firebase/app'));
    expect(swap.resolveId('firebase/storage', rowId('firebase/firestore'))).toStartWith(STOP_PREFIX);
    expect(swap.resolveId('firebase/app', userFirebaseFile)).toBe(rowId('firebase/app'));
  });

  it('give the row modules their one observer, and no other importer', () => {
    expect(swap.resolveId(OBSERVER_SPECIFIER, rowId('firebase/auth'))).toBe(OBSERVER_MODULE_ID);
    expect(swap.resolveId(OBSERVER_SPECIFIER, userImporter)).toBeNull();
  });

  it("load the fixed modules' source from the opened package", async () => {
    expect(await swap.loadPluginModule(rowId('firebase/auth'))).toBe(fakePackage.moduleSource(rowId('firebase/auth')));
    expect(await swap.loadPluginModule(OBSERVER_MODULE_ID)).toBe(fakePackage.moduleSource(OBSERVER_MODULE_ID));
  });

  it('refuse every other served specifier with the supplier error, never the sandbox entry', async () => {
    const refused = SDK_MODULES.filter((specifier) => !INSTALLED_SDK_SPECIFIERS.has(specifier));
    expect(refused).toContain('firebase/storage');
    expect(refused).toContain('firebase/database');
    for (const specifier of refused) {
      const id = swap.resolveId(specifier, userImporter);
      expect(id).toStartWith(STOP_PREFIX);
      expect(Object.values(context.entries)).not.toContain(id);
      const error = await thrownBy(await swap.loadPluginModule(id as string));
      expect(error.code).toBe('SUPPLIED_REFUSED');
      expect(error.message).toBe(`refused ${specifier} on the page`);
    }
  });

  it("declare the refused module's export names, so the page's named import links and gets the refusal", async () => {
    const source = await swap.loadPluginModule(swap.resolveId('firebase/storage', userImporter) as string);
    expect(source).toContain('__pyricStopped as getStorage');
  });

  it('refuse a real subpath pyric does not serve, and firebase-admin, on the page', async () => {
    for (const specifier of ['firebase/installations', 'firebase/firestore/lite', 'firebase/compat/app', 'firebase-admin']) {
      const id = swap.resolveId(specifier, userImporter);
      expect(id).toStartWith(STOP_PREFIX);
      const error = await thrownBy(await swap.loadPluginModule(id as string));
      expect(error.code).toBe('SUPPLIED_REFUSED');
      expect(error.message).toBe(`refused ${specifier} on the page`);
    }
  });

  it("refuse an @firebase/* import from app code, and leave the installed SDK's own to Vite", async () => {
    const sdkFile = realpathSync(createRequire(import.meta.url).resolve('firebase/firestore'));
    expect(sdkFile).toContain(`${sep}node_modules${sep}`);
    for (const specifier of ['@firebase/firestore', '@firebase/storage', '@firebase/database', '@firebase/app']) {
      for (const importer of [userImporter, undefined, `${userImporter}?import`]) {
        const id = swap.resolveId(specifier, importer);
        expect(id).toStartWith(STOP_PREFIX);
        const error = await thrownBy(await swap.loadPluginModule(id as string));
        expect(error.code).toBe('SUPPLIED_REFUSED');
        expect(error.message).toBe(`refused ${specifier} on the page`);
      }
    }
    // An SDK file the rows did not load gets no allowance, whatever its manifest says.
    expect(swap.resolveId('@firebase/firestore', sdkFile)).toStartWith(STOP_PREFIX);
    const rows = suppliedRows(refusal);
    rows.open(fakePackage);
    const loaded = createViteModuleSwap(context, { supplied: rows });
    rows.liveSdkUrls.add(pathToFileURL(sdkFile).href);
    expect(loaded.resolveId('@firebase/firestore', sdkFile)).toBeNull();
    expect(loaded.resolveId('@firebase/app', `${sdkFile}?v=1234`)).toBeNull();
  });

  it('decide by the file an import reaches: only the rows, and SDK files they loaded, reach the installed SDK', async () => {
    const requireHere = createRequire(import.meta.url);
    const entryFile = realpathSync(requireHere.resolve('firebase/firestore'));
    const packageFile = realpathSync(createRequire(entryFile).resolve('@firebase/firestore'));
    const rows = suppliedRows(refusal);
    rows.open(fakePackage);
    const gated = createViteModuleSwap(context, { supplied: rows });
    const reaching = (file: string): SwapResolveContext => ({ environment: clientEnvironment, resolve: async () => ({ id: file }) });
    const resolveTo = (file: string, source: string, importer: string | undefined) =>
      gated.resolvePluginId(reaching(file), source, importer);

    // Around the rows: a relative path, a /@fs/ URL, or a browser request, before any row loaded the file.
    for (const [source, importer] of [['./node_modules/@firebase/firestore/dist/index.esm.js', userImporter], [`/@fs${packageFile}`, userImporter], [packageFile, undefined]] as const) {
      const id = await resolveTo(packageFile, source, importer);
      expect(id).toStartWith(STOP_PREFIX);
      const error = await thrownBy(await gated.loadPluginModule(id as string));
      expect(error.message).toBe(`refused ${source} on the page`);
    }
    expect(rows.liveSdkUrls.size).toBe(0);

    // The row's own import, then that file's import of its package, load and are recorded.
    expect(await resolveTo(entryFile, aliased('firebase/firestore'), rowId('firebase/firestore'))).toEqual({ id: entryFile });
    expect(await resolveTo(packageFile, '@firebase/firestore', entryFile)).toEqual({ id: packageFile });
    expect(rows.liveSdkUrls).toEqual(new Set([pathToFileURL(entryFile).href, pathToFileURL(packageFile).href]));
    // The browser's request for a file the rows loaded is that file's own load.
    expect(await resolveTo(packageFile, `/@fs${packageFile}`, undefined)).toEqual({ id: packageFile });
    // App code reaching the same, already loaded file by path is still refused.
    expect(await resolveTo(packageFile, `/@fs${packageFile}`, userImporter)).toStartWith(STOP_PREFIX);
    expect(await resolveTo(packageFile, './node_modules/@firebase/firestore/dist/index.esm.js', userImporter)).toStartWith(STOP_PREFIX);
    // A file that is not part of the SDK is left alone.
    expect(await resolveTo(userImporter, './other.js', userImporter)).toEqual({ id: userImporter });
  });

  it('leave an import that is not firebase to Vite', () => {
    expect(swap.resolveId('firebase-tools', userImporter)).toBeNull();
    expect(swap.resolveId('react', userImporter)).toBeNull();
  });

  it("pass a row module's own import through the dev server alias to Vite, never asking the stop", async () => {
    const fake = fakeContext(clientEnvironment);
    expect(await swap.resolvePluginId(fake, aliased('firebase/auth'), userImporter)).toBe(rowId('firebase/auth'));
    expect(await swap.resolvePluginId(fake, aliased('firebase/auth'), rowId('firebase/auth'))).toEqual({ id: '/node_modules/firebase/auth.js' });
    expect(fake.passedOn).toEqual(['firebase/auth']);
  });

  it('refuse server-rendered firebase and firebase-admin imports, never routing them to the sandbox', async () => {
    const fake = fakeContext(runnableSsr);
    for (const specifier of ['firebase/firestore', 'firebase/storage', 'firebase-admin/app']) {
      const id = await swap.resolvePluginId(fake, aliased(specifier), userImporter);
      expect(id).toStartWith(STOP_PREFIX);
      const error = await thrownBy(await swap.loadPluginModule(id as string));
      expect(error.message).toBe(`refused ${specifier} on the server`);
    }
    expect(fake.passedOn).toEqual([]);
  });
});

describe('live rows that are still shut', () => {
  const swap = createViteModuleSwap(context, { supplied: suppliedRows(refusal) });

  it('refuse every served specifier, from any importer, the fixed row modules included', async () => {
    const fake = fakeContext(clientEnvironment);
    for (const importer of [userImporter, userFirebaseFile, ...ROW_MODULE_IDS.values()]) {
      for (const specifier of SDK_MODULES) {
        expect(swap.resolveId(specifier, importer)).toStartWith(STOP_PREFIX);
        expect(await swap.resolvePluginId(fake, aliased(specifier), importer)).toStartWith(STOP_PREFIX);
      }
    }
    expect(fake.passedOn).toEqual([]);
  });

  it("refuse @firebase/* even from the installed SDK's own files", () => {
    const sdkFile = realpathSync(createRequire(import.meta.url).resolve('firebase/firestore'));
    expect(swap.resolveId('@firebase/firestore', sdkFile)).toStartWith(STOP_PREFIX);
  });

  it('serve no row module source', async () => {
    await expect(swap.loadPluginModule(rowId('firebase/app'))).rejects.toThrow('has not opened the rows');
  });
});

describe('the public seam, in a project without @pyric/live', () => {
  // The review probe: a supplier naming its own file as a row module.
  const probeInput = {
    modules: new Map([['firebase/app', userFirebaseFile]]),
    refusal,
  } as unknown as Parameters<typeof pyricWithSuppliedRows>[1];

  it("never lets a user file's import of firebase/app reach the installed SDK", async () => {
    const plugin = pyricWithSuppliedRows({}, probeInput);
    const fake = { ...fakeContext(clientEnvironment), environment: clientEnvironment };
    const resolveHook = plugin.resolveId as (this: unknown, source: string, importer: string, options: object) => Promise<unknown>;
    for (const importer of [userFirebaseFile, rowId('firebase/app')]) {
      expect(await resolveHook.call(fake, aliased('firebase/app'), importer, {})).toStartWith(STOP_PREFIX);
      expect(await resolveHook.call(fake, 'firebase/app', importer, {})).toStartWith(STOP_PREFIX);
    }
    expect(fake.passedOn).toEqual([]);
  });

  it('refuses to start the dev server, so the stop stays shut', async () => {
    const root = project(false);
    const start = createServer({ root, configFile: false, logLevel: 'silent', plugins: [pyricWithSuppliedRows({}, probeInput)] });
    await expect(start).rejects.toThrow('live rows need @pyric/live installed in the project');
  });
});

describe('the installed @pyric/live', () => {
  it('is found from the project root and gives the fixed row modules their source', async () => {
    const found = await loadRowModulePackage(project(true));
    expect(found.root).toBe(realpathSync(fileURLToPath(new URL('../../../live', import.meta.url))));
    expect(found.moduleSource(rowId('firebase/firestore'))).toContain('export * from "firebase/firestore";');
    expect(found.moduleSource(OBSERVER_MODULE_ID)).toContain('sendObservedCall');
    expect(found.moduleSource(userFirebaseFile)).toBeNull();
  });

  it('is required: a project without it gets an error', async () => {
    await expect(loadRowModulePackage(project(false))).rejects.toThrow('live rows need @pyric/live installed');
  });
});
