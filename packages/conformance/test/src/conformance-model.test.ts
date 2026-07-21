import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { canIUse, deriveConformanceModel, registerImportEvidence, type ConformanceModel, type FeatureSupport } from '../../src/conformance-model.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { surfaceContracts } from '../../surfaces/load.ts';

let model: ConformanceModel;
beforeAll(async () => { model = await deriveConformanceModel(); }, 60_000);

function one(query: string): FeatureSupport {
  const result = canIUse(model, query);
  if (result.match !== 'exact' || result.supports.length !== 1) {
    throw new Error(`expected one exact result for ${query}, got ${result.match}/${result.supports.length}`);
  }
  return result.supports[0]!;
}

describe('multi-axis conformance model', () => {
  it('supplies the shared assurance and rules-report projections in memory', () => {
    expect(Object.keys(model.assuranceNodeVerdicts)).toHaveLength(1083);
    expect(Object.keys(model.nodeVerdicts).length).toBeGreaterThan(Object.keys(model.assuranceNodeVerdicts).length);
    expect(model.rulesLanguage.capability.engines).toHaveLength(3);
    expect(model.rulesLanguage.coverage.engines).toHaveLength(3);
    expect(model.rulesLanguage.firestoreScorecard.score).toEqual({
      numerator: 126, denominator: 140, ratio: 126 / 140, percent: 90,
    });
    expect(model.documentation.registries.length).toBeGreaterThan(0);
    expect(model.documentation.descriptors.length).toBeGreaterThan(0);
    expect(model.documentation.rows.length).toBeGreaterThan(600);
    expect(model.documentation.coverageBaseline.overall.publicSurface.runtime.denominator).toBeGreaterThan(0);
    expect(model.evidence.observations.length).toBeGreaterThan(0);
    expect(Object.keys(model.evidence.observationExceptions).length).toBeGreaterThan(0);
  });

  it('indexes every developer feature to all of its conformance claims', () => {
    expect(model.featureIndex['storage/getDownloadURL']).toEqual(expect.arrayContaining([
      'storage#51',
      'storage#52',
    ]));
    expect(model.featureIndex['firestore-rules/request.query']).toContain('firestore.binding.request.query');
    expect(Object.values(model.featureIndex).flat().every((id) => id in model.nodeVerdicts)).toBe(true);
    expect(Object.values(model.featureIndex).every((ids) => ids.length > 0)).toBe(true);
    expect(model.featureIndex['rtdb/onDisconnect']).toContain('database:runtime:onDisconnect');
  });

  it('keeps package-export ownership separate from registry surface ownership', () => {
    expect(canIUse(model, 'getDownloadURL', { importPath: 'pyric/storage' })).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({
        surface: 'storage',
        importPaths: ['pyric/storage'],
        evidenceSlug: 'storage-compat',
      })],
    });
    expect(canIUse(model, 'onDisconnect', { importPath: 'pyric/database' })).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({ surface: 'rtdb', availability: 'deferred' })],
    });
    expect(canIUse(model, 'getDownloadURL', { importPath: 'pyric/firestore' }).match).toBe('none');
    const appGetAuth = canIUse(model, 'getAuth', { importPath: 'pyric/app' });
    expect(appGetAuth.match).not.toBe('exact');
    expect(appGetAuth.supports.map(({ feature }) => feature)).not.toContain('getAuth');
    expect(canIUse(model, 'getAuth', { importPath: 'pyric/auth' }).match).toBe('exact');
    expect(canIUse(model, 'getToken', { importPath: 'pyric/messaging' }).match).toBe('exact');
    const siblingEntry = canIUse(model, 'getToken', { importPath: 'pyric/messaging/sw' });
    expect(siblingEntry.match).not.toBe('exact');
    expect(siblingEntry.supports.map(({ feature }) => feature)).not.toContain('getToken');
  });

  it('scopes published native and registry-only APIs without scoping rules constructs', () => {
    expect(canIUse(model, 'evaluateStorageRules', { importPath: 'pyric/storage' }).match).toBe('exact');
    expect(canIUse(model, 'send', { importPath: 'pyric-admin/messaging' })).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({ surface: 'messaging-admin', availability: 'available' })],
    });
    expect(canIUse(model, 'getAfter', { importPath: 'pyric/rules' }).match).toBe('none');
  });

  it('fails closed when one published import is assigned to different evidence surfaces', () => {
    const evidence = new Map();
    const firestore = { importPath: 'pyric/rules', surface: 'firestore-rules', evidenceSlug: 'rules-compat' } as const;
    registerImportEvidence(evidence, firestore);
    expect(() => registerImportEvidence(evidence, {
      importPath: 'pyric/rules',
      surface: 'storage-rules',
      evidenceSlug: 'rules-compat',
    })).toThrow('conflicting evidence associations');
    expect(() => registerImportEvidence(evidence, firestore)).not.toThrow();
    expect(evidence.size).toBe(1);
  });

  it('keeps known unsupported behavior distinct from missing verification', () => {
    expect(one('storage/connectStorageEmulator')).toMatchObject({
      availability: 'available',
      fidelity: 'unsupported',
      assurance: 'ineligible',
    });
  });

  it('keeps baseline-tolerated type gaps queryable without claiming runtime availability', () => {
    expect(canIUse(model, 'auth/ApplicationVerifier')).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({
        feature: 'ApplicationVerifier',
        surface: 'auth',
        availability: 'unavailable',
        fidelity: 'not-applicable',
        assurance: 'not-applicable',
        claims: [expect.objectContaining({ id: 'auth:type:ApplicationVerifier', status: 'unmapped' })],
      })],
    });
    expect(model.census.find(({ surface }) => surface === 'auth')?.types.unmapped).toContain('ApplicationVerifier');
    const indexedClaims = new Set(Object.values(model.featureIndex).flat());
    for (const entry of model.census) {
      for (const symbol of entry.types.unmapped) {
        expect(indexedClaims).toContain(`${entry.surface}:type:${symbol}`);
      }
    }
  });

  it('makes the census gate consume census facts through the conformance model', () => {
    const source = readFileSync(new URL('../../src/census-gate.ts', import.meta.url), 'utf8');
    expect(source).toContain('deriveConformanceModel');
    expect(source).not.toContain('surface-census.ts');
    expect(source).not.toContain('execFileSync');
  });

  it('reports getAfter as available, diverged, and assurance-ineligible', () => {
    const result = one('getAfter');
    expect(result).toMatchObject({
      surface: 'firestore-rules', availability: 'available', fidelity: 'diverged', assurance: 'ineligible',
    });
    expect(result.claims.map(({ id }) => id)).toEqual(['firestore-rules#164', 'firestore.function.getAfter']);
  });

  it('joins rules fidelity through structured construct ids', () => {
    const result = one('firestore-rules/operator.slice');
    expect(result.claims.map(({ id }) => id)).toContain('firestore-rules#173');
  });

  it('preserves qualified rules binding identity instead of collapsing to the id tail', () => {
    const result = one('firestore-rules/request.query');
    expect(result.feature).toBe('request.query');
    expect(result.claims.map(({ id }) => id)).toContain('firestore.binding.request.query');
    expect(canIUse(model, 'firestore-rules/query').match).toBe('suggestions');
  });

  it('derives fidelity from rules-construct status when no registry row exists', () => {
    expect(one('firestore-rules/math.isInfinite')).toMatchObject({
      availability: 'available',
      fidelity: 'diverged',
      assurance: 'ineligible',
    });
  });

  it('requires behavioral evidence beyond production syntax acceptance', () => {
    for (const feature of ['set.difference', 'set.intersection', 'set.union']) {
      expect(one(`firestore-rules/${feature}`)).toMatchObject({
        availability: 'available',
        fidelity: 'unsupported',
        assurance: 'ineligible',
      });
    }
    for (const feature of ['duration.seconds', 'duration.nanos']) {
      expect(one(`firestore-rules/${feature}`)).toMatchObject({
        availability: 'available',
        fidelity: 'conforms',
        assurance: 'eligible',
      });
    }
  });

  it('requires graph-supported evidence for every conforming rules construct', () => {
    for (const support of model.supports.filter(({ surface }) => surface.endsWith('-rules'))) {
      const constructs = support.claims.filter(({ kind }) => kind === 'rules-construct');
      if (support.fidelity !== 'conforms' || constructs.length === 0) continue;
      for (const construct of constructs) {
        expect(model.nodeVerdicts[construct.id]).toBe('supported');
        expect(construct.assurance).toBe('eligible');
      }
    }
  });

  it('promotes canonical rules-inventory notes to human-facing caveats', () => {
    const result = one('firestore-rules/rule-kind.import');
    expect(result).toMatchObject({ availability: 'available', fidelity: 'unverified' });
    expect(result.caveats.join(' ')).toContain('not stock Firebase rules');
  });

  it('aggregates every getDownloadURL row and explains its local URL divergence', () => {
    const result = one('getDownloadURL');
    expect(result).toMatchObject({ surface: 'storage', availability: 'available', fidelity: 'diverged', assurance: 'qualified' });
    expect(result.claims.map(({ id }) => id)).toContain('storage#51');
    expect(result.claims.map(({ id }) => id)).toContain('storage#52');
    expect(result.caveats.join(' ')).toContain('page-local');
  });

  it('joins Messaging runtime and behavior claims under one developer surface', () => {
    const result = one('getToken');
    expect(result.surface).toBe('messaging');
    expect(result.claims.map(({ id }) => id)).toEqual([
      'messaging:runtime:getToken',
      'messaging#2',
      'messaging#7',
    ]);
  });

  it('does not contaminate features with unrelated family-row divergences', () => {
    expect(one('firestore/and').claims.map(({ id }) => id)).not.toContain('firestore#61');
    expect(one('storage/getMetadata').claims.map(({ id }) => id)).not.toContain('storage#86');
    expect(one('messaging-admin/send').claims.map(({ id }) => id)).toEqual(['messaging-admin#4']);
  });

  it('cannot silently drop a feature-bearing divergence from the query model', () => {
    const result = one('reauthenticateWithCredential');
    expect(result.fidelity).toBe('diverged');
    expect(result.claims.map(({ id }) => id)).toContain('auth#176');
  });

  it('reports onDisconnect as deferred with non-applicable trust axes', () => {
    expect(one('onDisconnect')).toMatchObject({
      feature: 'onDisconnect', surface: 'rtdb', availability: 'deferred',
      fidelity: 'not-applicable', assurance: 'not-applicable',
    });
  });

  it('does not contradict the structured resumable-upload availability in public prose', () => {
    const support = one('storage/uploadBytesResumable');
    expect(support.availability).toBe('deferred');
    expect([support.summary, ...support.caveats].join('\n').toLowerCase()).not.toContain('out of scope');
  });

  it('leaves disposition availability policy to the owning surface contracts', () => {
    const rows = new Map(allCompatibilityRows.map((row) => [row.id, row]));
    for (const { record } of surfaceContracts) {
      if (!('dispositions' in record)) continue;
      for (const disposition of record.dispositions) {
        for (const evidenceRef of disposition.evidenceRefs) {
          if (!evidenceRef.startsWith('registry:')) continue;
          const row = rows.get(evidenceRef.slice('registry:'.length));
          expect(row, evidenceRef).toBeDefined();
          const registryAvailabilityProse = `${row?.evidence ?? ''}\n${row?.exceptionReason ?? ''}`.toLowerCase();
          expect(registryAvailabilityProse, disposition.id).not.toMatch(/\bdefer(?:red|ral)?\b|\bout[- ]of[- ]scope\b/);
        }
      }
    }

    for (const source of ['index.ts', 'errors.ts']) {
      const text = readFileSync(new URL(`../../../pyric/src/storage/${source}`, import.meta.url), 'utf8').toLowerCase();
      expect(text, source).not.toContain('out of scope');
    }
  });

  it('does not let a mapped type export hide a deferred runtime value', () => {
    const result = one('firestore/AggregateField');
    expect(result).toMatchObject({
      feature: 'AggregateField', surface: 'firestore', availability: 'deferred',
      fidelity: 'not-applicable', assurance: 'not-applicable',
    });
    expect(result.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime-export', status: 'deferred' }),
      expect.objectContaining({ kind: 'type-export', status: 'mapped' }),
    ]));
  });

  it('preserves stable disposition identities in the central census', () => {
    const disposition = model.census
      .flatMap(({ runtime }) => runtime.dispositioned)
      .find(({ symbol }) => symbol === 'multiFactor');
    expect(disposition?.dispositionId).toBe('auth.mfa-phone-recaptcha');
  });

  it('returns stable candidates for ambiguous or fuzzy names', () => {
    const first = canIUse(model, 'getDown');
    const second = canIUse(model, 'getDown');
    expect(first).toEqual(second);
    expect(first.match).toBe('suggestions');
    expect(first.supports[0]?.feature).toBe('getDownloadURL');
  });

  it('does not present a fuzzy suggestion as an exact trust answer', () => {
    const result = canIUse(model, 'providerData');
    expect(result.match).toBe('exact');
    expect(result.supports[0]?.claims.map(({ id }) => id)).toContain('auth#182');
  });

  it('uses authored feature metadata rather than parsing registry display prose', () => {
    const source = readFileSync(new URL('../../src/conformance-model.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('row.api.match');
    expect(source).not.toContain('row.api.matchAll');
    expect(source).not.toContain("../../cli/");
    expect(model.documentation.rows.every(({ featureKeys }) => Array.isArray(featureKeys))).toBe(true);
  });
});
