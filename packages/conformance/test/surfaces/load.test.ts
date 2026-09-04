import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  censusOwnerProblems,
  loadCensusPairs,
  loadSurfaceDispositions,
  surfaceContracts,
  surfaceDescriptors,
  developerSurfaces,
  surfaceReferenceProblems,
  surfaceRecordProblems,
} from '../../surfaces/load.ts';
import { SURFACE_CONTRACT_SCHEMA } from '../../surfaces/types.ts';
import surfaceContractJsonSchema from '../../schemas/surface-contract.v2.schema.json' with { type: 'json' };

describe('machine-readable surface contracts', () => {
  it('loads every authored contract through one schema-validated seam', () => {
    expect(surfaceContracts).toHaveLength(18);
    expect(surfaceContracts.map(({ key }) => key)).toEqual(surfaceContracts.map(({ key }) => key).toSorted());
    expect(surfaceContracts.every(({ record }) => !('order' in record))).toBe(true);
    expect(surfaceDescriptors).toHaveLength(17);
    expect(loadCensusPairs()).toHaveLength(8);
    expect(loadSurfaceDispositions()).toHaveLength(37);
  });

  it('models the service-worker census-only surface as a contract, not code', () => {
    const contract = surfaceContracts.find(({ key }) => key === 'messaging-sw');
    expect(contract?.record).toMatchObject({
      schema: SURFACE_CONTRACT_SCHEMA,
      kind: 'census-only',
      censusSurface: 'messaging-sw',
      upstream: 'firebase/messaging/sw',
    });
    expect(surfaceDescriptors.map(({ surface }) => String(surface)).includes('messaging-sw')).toBe(false);
  });

  it('authors every developer-facing owner and alias in the contracts', () => {
    const owners = new Map(surfaceContracts.map(({ key, record }) => [key, record.developerSurface]));
    expect(owners.get('rtdb-modular')).toBe('rtdb');
    expect(owners.get('messaging-sw')).toBe('messaging');
    expect(owners.get('firestore-rules')).toBe('firestore-rules');
  });

  it('resolves developer-facing owners from the contract directory index', () => {
    const app = surfaceContracts.find(({ key }) => key === 'app')?.record;
    if (app?.kind !== 'mirror') throw new Error('expected App mirror contract');
    expect(surfaceReferenceProblems([{
      key: 'app',
      file: 'app.json',
      record: { ...app, developerSurface: 'missing' as typeof app.developerSurface },
    }])).toEqual([
      "surfaces/app.json: developerSurface 'missing' is not a canonical developer surface",
    ]);
    expect(surfaceReferenceProblems([{
      key: 'new-surface',
      file: 'new-surface.json',
      record: { ...app, developerSurface: 'new-surface' as typeof app.developerSurface },
    }])).toEqual([]);
  });

  it('derives developer surfaces from self-owned records and rejects unknown aliases', () => {
    expect(developerSurfaces).toEqual([
      'ai', 'app', 'auth', 'auth-flutter', 'firestore', 'firestore-flutter', 'firestore-kotlin', 'firestore-rules', 'firestore-swift',
      'functions-rtdb', 'messaging', 'messaging-admin', 'rtdb', 'rtdb-rules', 'storage', 'storage-rules',
    ]);
    expect(surfaceContractJsonSchema.$defs.developerSurface).not.toHaveProperty('enum');
    const app = surfaceContracts.find(({ key }) => key === 'app')?.record;
    if (app?.kind !== 'mirror') throw new Error('expected App mirror contract');
    expect(surfaceRecordProblems('typo.json', { ...app, developerSurface: 'firestor' })).toEqual([]);
    expect(surfaceReferenceProblems([{
      key: 'app', file: 'app.json', record: { ...app, developerSurface: 'firestor' },
    }])).toEqual(["surfaces/app.json: developerSurface 'firestor' is not a canonical developer surface"]);
  });

  it('assigns each census surface to at most one developer-facing coverage owner', () => {
    const owners = surfaceDescriptors.flatMap((descriptor) =>
      descriptor.kind === 'mirror' && descriptor.coverage ? [descriptor.censusSurface] : [],
    );
    expect(new Set(owners).size).toBe(owners.length);
    const messagingAdmin = surfaceDescriptors.find(({ surface }) => surface === 'messaging-admin');
    expect(messagingAdmin).toMatchObject({ kind: 'registry-only', coverage: false });
    expect(messagingAdmin).not.toHaveProperty('censusSurface');
    expect(messagingAdmin).not.toHaveProperty('upstream');
    expect(messagingAdmin).not.toHaveProperty('mirrors');
  });

  it('rejects collisions between coverage mirrors and census-only owners', () => {
    const messaging = surfaceContracts.find(({ key }) => key === 'messaging')?.record;
    const messagingSw = surfaceContracts.find(({ key }) => key === 'messaging-sw')?.record;
    if (messaging?.kind !== 'mirror' || messagingSw?.kind !== 'census-only') throw new Error('expected messaging contracts');
    expect(censusOwnerProblems([
      { file: 'messaging.json', record: messaging },
      { file: 'messaging-sw.json', record: { ...messagingSw, censusSurface: messaging.censusSurface } },
    ])).toEqual([
      "surfaces/messaging-sw.json: census surface 'messaging' has multiple developer owners (also in messaging.json)",
    ]);
  });

  it('rejects executable-shape drift and unknown fields at the contract seam', () => {
    const problems = surfaceRecordProblems('bad.json', {
      schema: SURFACE_CONTRACT_SCHEMA,
      kind: 'native',
      registry: 'rules',
      symbolSource: 'pyric/rules',
      observationPrefixes: ['rules-'],
      coverage: true,
      scopeNote: 'test',
      captureRigs: [],
      status: 'supported',
    });
    expect(problems.some((problem) => problem.includes('status'))).toBe(true);
  });

  it('rejects evidence routing on contract kinds whose routing is derived or ignored', () => {
    const app = surfaceContracts.find(({ key }) => key === 'app')?.record;
    const messagingSw = surfaceContracts.find(({ key }) => key === 'messaging-sw')?.record;
    if (app?.kind !== 'mirror' || messagingSw?.kind !== 'census-only') throw new Error('expected census contracts');
    expect(surfaceRecordProblems('app.json', { ...app, evidenceImports: ['pyric/app'] }).length).toBeGreaterThan(0);
    expect(surfaceRecordProblems('messaging-sw.json', {
      ...messagingSw,
      evidenceImports: ['pyric/messaging/sw'],
    }).length).toBeGreaterThan(0);
  });

  it('requires dispositions consistently in the executable and published schemas', () => {
    const app = surfaceContracts.find(({ key }) => key === 'app')?.record;
    expect(app?.kind).toBe('mirror');
    if (app?.kind !== 'mirror') throw new Error('expected App mirror contract');
    const { dispositions: _dispositions, ...withoutDispositions } = app;
    expect(surfaceRecordProblems('fixture.json', withoutDispositions))
      .toContain("surfaces/fixture.json: Required at 'dispositions'");
  });

  it('rejects a disposition whose registry evidence target does not exist', () => {
    const app = surfaceContracts.find(({ key }) => key === 'app')?.record;
    expect(app?.kind).toBe('mirror');
    if (app?.kind !== 'mirror') throw new Error('expected App mirror contract');
    const problems = surfaceRecordProblems('fixture.json', {
      ...app,
      dispositions: [{ ...app.dispositions[0], evidenceRefs: ['registry:nope#999'] }],
    });
    expect(problems.some((problem) => problem.includes("registry evidence target 'nope#999' does not exist"))).toBe(true);
  });

  it('keeps every disposition grouped with its owning census contract', () => {
    const auth = surfaceContracts.find(({ key }) => key === 'auth')?.record;
    expect(auth?.kind).toBe('mirror');
    if (auth?.kind !== 'mirror') throw new Error('expected Auth mirror contract');
    expect(auth.dispositions.flatMap(({ symbols }) => symbols)).toContain('multiFactor');
    expect(loadSurfaceDispositions().find(({ surface, symbol }) => surface === 'auth' && symbol === 'multiFactor'))
      .toMatchObject({
        dispositionId: 'auth.mfa-phone-recaptcha',
        availability: 'deferred',
        reasonCode: 'implementation-deferred',
        evidenceRefs: expect.arrayContaining(['registry:auth#180']),
      });
  });

  it('pairs each disposition availability with its own reason code', () => {
    const dispositions = loadSurfaceDispositions();
    expect(dispositions.find(({ surface, symbol }) => surface === 'auth' && symbol === 'fetchSignInMethodsForEmail'))
      .toMatchObject({
        dispositionId: 'auth.email-enumeration',
        availability: 'out-of-scope',
        reasonCode: 'upstream-deprecated',
      });
    for (const disposition of dispositions) {
      expect(disposition.reasonCode).toBe(
        disposition.availability === 'deferred' ? 'implementation-deferred' : 'upstream-deprecated',
      );
    }
  });

  it('publishes a versioned JSON Schema that validates every authored contract', () => {
    const schema = JSON.parse(readFileSync(new URL('../../schemas/surface-contract.v2.schema.json', import.meta.url), 'utf8'));
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://pyric.dev/schemas/conformance/surface-contract.v2.schema.json',
    });
    expect(schema.$defs.disposition.required).toEqual(expect.arrayContaining([
      'id', 'availability', 'reasonCode', 'summary', 'evidenceRefs', 'symbols',
    ]));
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    for (const { key, record } of surfaceContracts) {
      expect(validate(record), `${key}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('uses the published schema as the executable raw-acceptance contract', () => {
    const app = surfaceContracts.find(({ key }) => key === 'app')?.record;
    if (app?.kind !== 'mirror') throw new Error('expected App mirror contract');
    const cases: Array<{ name: string; value: unknown; valid: boolean }> = [
      { name: 'authored contract', value: app, valid: true },
      {
        name: 'whitespace-padded evidence reference',
        value: { ...app, dispositions: [{ ...app.dispositions[0], evidenceRefs: [' upstream:firebase/app '] }] },
        valid: false,
      },
      {
        name: 'whitespace-only summary',
        value: { ...app, dispositions: [{ ...app.dispositions[0], summary: '   ' }] },
        valid: false,
      },
      {
        name: 'out-of-scope implementation deferral',
        value: { ...app, dispositions: [{ ...app.dispositions[0], availability: 'out-of-scope', reasonCode: 'implementation-deferred' }] },
        valid: false,
      },
      {
        name: 'deferred upstream deprecation',
        value: { ...app, dispositions: [{ ...app.dispositions[0], availability: 'deferred', reasonCode: 'upstream-deprecated' }] },
        valid: false,
      },
      {
        name: 'missing exact private-runtime classifications',
        value: { ...app, privateRuntimeExports: undefined },
        valid: false,
      },
      {
        name: 'non-private name in private-runtime classifications',
        value: { ...app, privateRuntimeExports: ['publicName'] },
        valid: false,
      },
      { name: 'unknown field', value: { ...app, executablePolicy: true }, valid: false },
    ];
    for (const fixture of cases) {
      expect(surfaceRecordProblems('app.json', fixture.value).length === 0, fixture.name).toBe(fixture.valid);
    }
  });
});
