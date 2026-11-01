/**
 * The async fallback hook (`register/hooks.ts`, `module.register()`), which
 * Node runs on its loader thread only below 22.15. `@pyric/cli` requires
 * 22.15, so no registered process in CI ever runs it; this calls its exported
 * `resolve` directly against the real SDK files on disk.
 */
import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from '../../src/register/hooks.js';
import { REAL_SDK_STOPPED_CODE } from '../../src/register/swap-or-stop.js';

const repoRoot = resolvePath(import.meta.dir, '../../../..');
const realAdminFile = realpathSync(createRequire(join(repoRoot, 'package.json')).resolve('firebase-admin/app'));
const realAdminUrl = pathToFileURL(realAdminFile).href;
const APP_IMPORTER = 'file:///work/app/src/route.mjs';

const context = (parentURL: string) => ({ parentURL, conditions: ['node', 'import'], importAttributes: {} });

/** A resolver standing in for Node's: every specifier lands on the real firebase-admin file. */
const toRealAdmin = async () => ({ url: realAdminUrl });

async function codeOf(load: Promise<unknown>): Promise<string> {
  try {
    await load;
    return 'loaded';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe('register/hooks.ts resolve (the async fallback hook)', () => {
  it('stops an npm alias that resolves into the real firebase-admin', async () => {
    expect(await codeOf(resolve('admin/app', context(APP_IMPORTER), toRealAdmin))).toBe(REAL_SDK_STOPPED_CODE);
  });

  it('maps firebase-admin/app to the sandbox', async () => {
    const asked: string[] = [];
    const result = await resolve('firebase-admin/app', context(APP_IMPORTER), async (specifier) => {
      asked.push(specifier);
      return { url: 'file:///work/app/node_modules/pyric-admin/dist/app/index.js' };
    });
    expect({ asked, url: result.url }).toEqual({ asked: ['pyric-admin/app'], url: 'file:///work/app/node_modules/pyric-admin/dist/app/index.js' });
  });

  it('stops a createRequire forge of a firebase-admin importer it never allowed', async () => {
    const forged = pathToFileURL(join(dirname(dirname(dirname(realAdminFile))), 'x.js')).href;
    expect(await codeOf(resolve('./lib/app/index.js', context(forged), toRealAdmin))).toBe(REAL_SDK_STOPPED_CODE);
  });
});
