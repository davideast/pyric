import { beforeAll, describe, expect, it } from 'bun:test';
import { renderBrowserQuery, renderCliQuery } from '../../src/can-i-use-template.ts';
import { deriveConformanceModel, type ConformanceModel } from '../../src/conformance-model.ts';

let model: ConformanceModel;
beforeAll(async () => { model = await deriveConformanceModel(); }, 60_000);

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
    expect(Buffer.byteLength(source)).toBeLessThan(500_000);
  });
});
