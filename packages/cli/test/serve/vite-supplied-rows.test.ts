/**
 * Supplied rows on the Vite page plane: the four rows another package may
 * serve from the installed SDK, the refusal of every other served
 * specifier, and the refusal of every server-rendered Firebase import.
 */
import { describe, expect, it } from 'bun:test';
import { SDK_MODULES, type ServedFirebaseSpecifier } from '../../src/serve/firebase-module-swap.js';
import {
  createViteModuleContext,
  createViteModuleSwap,
  type SwapEnvironment,
  type SwapResolveContext,
} from '../../src/serve/vite-module-swap.js';
import { INSTALLED_SDK_SPECIFIERS, suppliedRows, type SuppliedRowsPlane } from '../../src/serve/vite-supplied-rows.js';
import { SSR_SWAP_PREFIX } from '../../src/serve/vite-ssr-routing.js';

const STOP_PREFIX = '\0pyric-stop:';
const userImporter = '/some/app/src/main.ts';
const moduleId = (specifier: string) => `\0supplied:${specifier}`;
const refusals: Array<[string, SuppliedRowsPlane]> = [];
const refusal = (specifier: string, plane: SuppliedRowsPlane): Error => {
  refusals.push([specifier, plane]);
  return Object.assign(new Error(`refused ${specifier} on the ${plane}`), { code: 'SUPPLIED_REFUSED' });
};
const rows = suppliedRows({
  modules: new Map([...INSTALLED_SDK_SPECIFIERS].map((specifier) => [specifier, moduleId(specifier)])),
  refusal,
});
const context = createViteModuleContext();
const swap = createViteModuleSwap(context, { supplied: rows });

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

describe('supplied rows on the page plane', () => {
  it('serve their four specifiers from their own modules, for app and dependency importers', () => {
    for (const specifier of INSTALLED_SDK_SPECIFIERS) {
      expect(swap.resolveId(specifier, userImporter)).toBe(moduleId(specifier));
      expect(swap.resolveId(specifier, '/app/node_modules/a-library/index.js')).toBe(moduleId(specifier));
    }
  });

  it("send only a row module's own import of its specifier to the installed SDK", () => {
    expect(swap.resolveId('firebase/firestore', moduleId('firebase/firestore'))).toBeNull();
    // Another row's module gets the row, never the installed SDK.
    expect(swap.resolveId('firebase/app', moduleId('firebase/firestore'))).toBe(moduleId('firebase/app'));
    expect(swap.resolveId('firebase/storage', moduleId('firebase/firestore'))).toStartWith(STOP_PREFIX);
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
    const id = swap.resolveId('firebase/storage', userImporter) as string;
    const source = await swap.loadPluginModule(id);
    expect(source).toContain('__pyricStopped as getStorage');
  });

  it('leave a real subpath pyric does not serve to the stop', async () => {
    const id = swap.resolveId('firebase/installations', userImporter);
    expect(id).toStartWith(STOP_PREFIX);
    const error = await thrownBy(await swap.loadPluginModule(id as string));
    expect(error.code).toBe('PYRIC_REAL_SDK_STOPPED');
  });

  it("pass a row module's own import through the dev server alias to Vite, never asking the stop", async () => {
    const fake = fakeContext(clientEnvironment);
    const aliased = `${SSR_SWAP_PREFIX}firebase/auth`;
    expect(await swap.resolvePluginId(fake, aliased, userImporter)).toBe(moduleId('firebase/auth'));
    expect(await swap.resolvePluginId(fake, aliased, moduleId('firebase/auth'))).toEqual({ id: '/node_modules/firebase/auth.js' });
    expect(fake.passedOn).toEqual(['firebase/auth']);
  });

  it('refuse server-rendered firebase and firebase-admin imports, never routing them to the sandbox', async () => {
    const fake = fakeContext(runnableSsr);
    for (const specifier of ['firebase/firestore', 'firebase/storage', 'firebase-admin/app']) {
      const id = await swap.resolvePluginId(fake, `${SSR_SWAP_PREFIX}${specifier}`, userImporter);
      expect(id).toStartWith(STOP_PREFIX);
      const error = await thrownBy(await swap.loadPluginModule(id as string));
      expect(error.message).toBe(`refused ${specifier} on the server`);
    }
    expect(fake.passedOn).toEqual([]);
  });
});

describe('a supplied row set', () => {
  it('cannot open the stop for a specifier outside the four', () => {
    for (const specifier of ['firebase/storage', 'firebase/database', 'firebase/ai'] as ServedFirebaseSpecifier[]) {
      expect(() => suppliedRows({ modules: new Map([[specifier, moduleId(specifier)]]), refusal })).toThrow(
        `cannot serve ${specifier} from the installed Firebase SDK`,
      );
    }
  });
});
