import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderBrowserQuery, renderCliQuery } from '../../src/can-i-use-template.ts';
import { deriveConformanceModel, type ConformanceModel, type FeatureSupport } from '../../src/conformance-model.ts';

/** Long enough that a repeat is shared prose from one registry row, not a
 * short stock phrase such as the unmirrored-type caveat. */
const PROSE_CAVEAT_LENGTH = 80;

let model: ConformanceModel;
beforeAll(async () => { model = await deriveConformanceModel(); }, 60_000);

async function loadBrowserSupports(source: string): Promise<unknown> {
  const path = join(mkdtempSync(join(tmpdir(), 'can-i-use-browser-')), 'projection.ts');
  writeFileSync(path, source);
  const projection = await import(path) as { CONFORMANCE_SUPPORTS: unknown };
  return projection.CONFORMANCE_SUPPORTS;
}

function syntheticSupport(feature: string, caveats: string[]): FeatureSupport {
  return {
    feature,
    surface: 'storage',
    importPaths: ['pyric/storage'],
    evidenceSlug: 'storage',
    availability: 'available',
    fidelity: 'diverged',
    assurance: 'eligible',
    summary: `${feature} summary`,
    caveats,
    claims: [],
  };
}

describe('can-i-use source template', () => {
  it('keeps the generated public availability type identical to the model contract', () => {
    const source = renderCliQuery(model);
    expect(source).toContain("export type Availability = 'available' | 'unavailable' | 'deferred' | 'out-of-scope';");
    expect(source).toContain('importPaths: readonly string[]; evidenceSlug: string;');
    expect(source).toContain("export type FeatureClaimKind = 'runtime-export' | 'type-export' | 'registry-row' | 'rules-construct';");
    expect(source).toContain('export const CONFORMANCE_IMPORT_EVIDENCE');
    expect(source).toContain('export interface CanIUseOptions');
  });

  it('does not encode live GitHub issue state in generated query data', () => {
    const source = renderCliQuery(model);
    expect(source).not.toContain('github.com/davideast/pyric/issues/201');
    expect(source).not.toContain('github.com/davideast/pyric/issues/205');
  });

  it('keeps claim evidence out of the compact browser projection', () => {
    const source = renderBrowserQuery(model);
    expect(source).toContain('export interface BrowserFeatureSupport');
    expect(source).not.toContain('FeatureClaim');
    expect(source).not.toContain('"claims":');
    // 600,000 until the App Check and AI Logic hunt rows (601 KB with one-sentence caveats); the reviewer decides budget or caveat format.
    expect(Buffer.byteLength(source)).toBeLessThan(610_000);
  });

  it('stores each shared caveat text once in the browser projection', () => {
    const source = renderBrowserQuery(model);
    const shared = model.supports
      .flatMap(({ caveats }) => caveats)
      .find((caveat, index, all) => caveat.length > PROSE_CAVEAT_LENGTH && all.indexOf(caveat) !== index);
    expect(shared).toBeDefined();
    expect(source.split(JSON.stringify(shared)).length - 1).toBe(1);
  });

  it('round-trips repeated, empty, and special-character caveats through the browser projection', async () => {
    const special = 'quote " backslash \\ newline \n tab \t separator   emoji \u{1F600} `code` ${template} </script>';
    const supports = [
      syntheticSupport('first', ['shared', special, '', 'shared']),
      syntheticSupport('second', ['', 'only-second', special]),
      syntheticSupport('third', []),
      syntheticSupport('fourth', ['shared', 'shared', 'shared']),
    ];
    const synthetic: ConformanceModel = { ...model, supports };
    const browser = await loadBrowserSupports(renderBrowserQuery(synthetic));
    expect(browser).toEqual(supports.map(({ claims: _claims, ...support }) => support));
  });
});
