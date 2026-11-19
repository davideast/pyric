import { describe, expect, it } from 'bun:test';
import {
  assembleRegistrySections,
  defineRowSection,
  type RegistryDirectoryHost,
  type RegistryEntryKind,
} from '../../registry/section-rows.ts';

interface VirtualTree {
  readonly directories: Readonly<Record<string, readonly string[]>>;
  readonly kinds: Readonly<Record<string, RegistryEntryKind>>;
  readonly modules: Readonly<Record<string, unknown>>;
}

function createVirtualHost(tree: VirtualTree): RegistryDirectoryHost {
  return {
    readDirectory(dirPath: string): readonly string[] {
      const entries = tree.directories[dirPath];
      if (entries === undefined) {
        throw new Error(`ENOENT: no such directory '${dirPath}'`);
      }
      return entries;
    },
    entryKind(entryPath: string): RegistryEntryKind {
      return tree.kinds[entryPath] ?? 'missing';
    },
    loadModule(filePath: string): unknown {
      if (!(filePath in tree.modules)) {
        throw new Error(`MODULE_NOT_FOUND: '${filePath}'`);
      }
      return tree.modules[filePath];
    },
  };
}

describe('section-rows registry assembler', () => {
  it('orders sections by section.order then slug, orders rows by optional order then rowRef, and strips order', () => {
    const firstSection = defineRowSection({
      surface: 'ai',
      order: 10,
      defaults: {
        section: 'Initialization',
        status: 'conforms',
      },
      expandTest: (file) => `packages/pyric/test/ai/${file}`,
    });
    const secondSection = defineRowSection({
      surface: 'ai',
      order: 20,
      prefix: '## Custom heading\n\nIntro paragraph.\n',
      publishInCompatibilityDocs: false,
      defaults: {
        section: 'Custom heading',
        status: 'diverged-documented',
        automation: 'unit-backed',
      },
    });

    const host = createVirtualHost({
      directories: {
        '/reg/ai': ['defaults.ts', 'server-process', 'init'],
        '/reg/ai/init': ['section.ts', 'zeta-ordered.ts', 'alpha-ordered.ts', 'new-row-b.ts', 'new-row-a.ts', '4a.ts'],
        '/reg/ai/server-process': ['section.ts', 'RS2.ts', 'RS1.ts', 'MD1-check.ts'],
      },
      kinds: {
        '/reg/ai/defaults.ts': 'file',
        '/reg/ai/init': 'directory',
        '/reg/ai/init/section.ts': 'file',
        '/reg/ai/init/zeta-ordered.ts': 'file',
        '/reg/ai/init/alpha-ordered.ts': 'file',
        '/reg/ai/init/new-row-b.ts': 'file',
        '/reg/ai/init/new-row-a.ts': 'file',
        '/reg/ai/init/4a.ts': 'file',
        '/reg/ai/server-process': 'directory',
        '/reg/ai/server-process/section.ts': 'file',
        '/reg/ai/server-process/RS2.ts': 'file',
        '/reg/ai/server-process/RS1.ts': 'file',
        '/reg/ai/server-process/MD1-check.ts': 'file',
      },
      modules: {
        '/reg/ai/init/section.ts': { section: firstSection },
        '/reg/ai/init/zeta-ordered.ts': {
          default: firstSection.row({
            order: 10,
            featureKeys: ['getAI'],
            api: 'getAI()',
            behavior: 'First authored row despite z prefix',
            automation: 'unit-backed',
            evidence: '`unit:instances.test.ts`',
            conformanceTests: ['instances.test.ts'],
          }),
        },
        '/reg/ai/init/alpha-ordered.ts': {
          default: firstSection.row({
            order: 20,
            featureKeys: ['getAI'],
            api: 'getAI()',
            behavior: 'Second authored row',
            automation: 'unit-backed',
            evidence: '`unit:instances.test.ts`',
            conformanceTests: ['instances.test.ts'],
          }),
        },
        '/reg/ai/init/new-row-b.ts': {
          default: firstSection.row({
            featureKeys: ['getAI'],
            api: 'getAI()',
            behavior: 'Unordered row B',
            automation: 'unit-backed',
            evidence: '`unit:instances.test.ts`',
            conformanceTests: ['instances.test.ts'],
          }),
        },
        '/reg/ai/init/new-row-a.ts': {
          default: firstSection.row({
            featureKeys: ['getAI'],
            api: 'getAI()',
            behavior: 'Unordered row A',
            automation: 'unit-backed',
            evidence: '`unit:instances.test.ts`',
            conformanceTests: ['instances.test.ts'],
          }),
        },
        '/reg/ai/init/4a.ts': {
          default: firstSection.row({
            featureKeys: ['getAI'],
            api: 'getAI()',
            behavior: 'Mixed digit-letter ref',
            automation: 'unit-backed',
            evidence: '`unit:instances.test.ts`',
            conformanceTests: ['instances.test.ts'],
          }),
        },
        '/reg/ai/server-process/section.ts': { section: secondSection },
        '/reg/ai/server-process/RS1.ts': {
          default: secondSection.row({
            order: 10,
            featureKeys: ['getAI'],
            api: 'getAI(app)',
            behavior: 'Registered server refusal',
            evidence: 'App scenario',
            conformanceTests: ['test/apps/sample/scenario.ts'],
          }),
        },
        '/reg/ai/server-process/RS2.ts': {
          default: secondSection.row({
            order: 20,
            section: 'Server-rendered modules under vite dev',
            featureKeys: ['getAI'],
            api: 'getAI(app) SSR',
            behavior: 'SSR refusal',
            evidence: 'App scenario',
            conformanceTests: ['test/apps/sample-ssr/scenario.ts'],
          }),
        },
        '/reg/ai/server-process/MD1-check.ts': {
          default: secondSection.row({
            featureKeys: ['getAI'],
            api: 'getAI(app) mixed ref',
            behavior: 'Mixed uppercase-hyphen ref',
            evidence: 'App scenario',
            conformanceTests: ['test/apps/sample-md/scenario.ts'],
          }),
        },
      },
    });

    const loaded = assembleRegistrySections('/reg/ai', host, {
      ignoreFiles: new Set(['defaults.ts']),
    });

    expect(loaded.blocks).toHaveLength(2);
    expect(loaded.blocks[0]?.prefix).toBe('## Initialization\n');
    expect(loaded.blocks[0]?.publishInCompatibilityDocs).toBeUndefined();
    expect(loaded.blocks[0]?.rows.map((r) => r.rowRef)).toEqual([
      'zeta-ordered',
      'alpha-ordered',
      '4a',
      'new-row-a',
      'new-row-b',
    ]);
    expect(loaded.blocks[0]?.rows[0]?.id).toBe('ai#zeta-ordered');
    expect(loaded.blocks[0]?.rows[0]?.conformanceTests).toEqual([
      'packages/pyric/test/ai/instances.test.ts',
    ]);
    expect('order' in (loaded.blocks[0]?.rows[0] ?? {})).toBe(false);

    expect(loaded.blocks[1]?.prefix).toBe('## Custom heading\n\nIntro paragraph.\n');
    expect(loaded.blocks[1]?.publishInCompatibilityDocs).toBe(false);
    expect(loaded.blocks[1]?.rows.map((r) => r.rowRef)).toEqual(['RS1', 'RS2', 'MD1-check']);
    expect(loaded.blocks[1]?.rows[1]?.section).toBe('Server-rendered modules under vite dev');
    expect(loaded.rowsOf('server-process').map((r) => r.id)).toEqual(['ai#RS1', 'ai#RS2', 'ai#MD1-check']);
    expect(() => loaded.rowsOf('missing-section')).toThrow("unknown registry section 'missing-section'");
  });

  it('throws with the path when a section directory lacks section.ts', () => {
    const host = createVirtualHost({
      directories: {
        '/reg/ai': ['init'],
        '/reg/ai/init': ['getai-idempotent.ts'],
      },
      kinds: {
        '/reg/ai/init': 'directory',
        '/reg/ai/init/getai-idempotent.ts': 'file',
      },
      modules: {},
    });

    expect(() => assembleRegistrySections('/reg/ai', host)).toThrow(
      '/reg/ai/init/section.ts: missing required section descriptor file',
    );
  });

  it('throws with the path when a section directory contains a non-row file or subdirectory', () => {
    const sec = defineRowSection({
      surface: 'ai',
      order: 10,
      defaults: { section: 'Init', status: 'conforms' },
    });

    const hostWithStrayFile = createVirtualHost({
      directories: {
        '/reg/ai': ['init'],
        '/reg/ai/init': ['section.ts', 'notes.md'],
      },
      kinds: {
        '/reg/ai/init': 'directory',
        '/reg/ai/init/section.ts': 'file',
        '/reg/ai/init/notes.md': 'file',
      },
      modules: {
        '/reg/ai/init/section.ts': { section: sec },
      },
    });
    expect(() => assembleRegistrySections('/reg/ai', hostWithStrayFile)).toThrow(
      "/reg/ai/init/notes.md: invalid row filename 'notes.md'",
    );

    const hostWithBadTsName = createVirtualHost({
      directories: {
        '/reg/ai': ['init'],
        '/reg/ai/init': ['section.ts', 'bad_underscore.ts'],
      },
      kinds: {
        '/reg/ai/init': 'directory',
        '/reg/ai/init/section.ts': 'file',
        '/reg/ai/init/bad_underscore.ts': 'file',
      },
      modules: {
        '/reg/ai/init/section.ts': { section: sec },
      },
    });
    expect(() => assembleRegistrySections('/reg/ai', hostWithBadTsName)).toThrow(
      "/reg/ai/init/bad_underscore.ts: invalid row filename 'bad_underscore.ts'",
    );

    const hostWithNestedDir = createVirtualHost({
      directories: {
        '/reg/ai': ['init'],
        '/reg/ai/init': ['section.ts', 'nested'],
      },
      kinds: {
        '/reg/ai/init': 'directory',
        '/reg/ai/init/section.ts': 'file',
        '/reg/ai/init/nested': 'directory',
      },
      modules: {
        '/reg/ai/init/section.ts': { section: sec },
      },
    });
    expect(() => assembleRegistrySections('/reg/ai', hostWithNestedDir)).toThrow(
      '/reg/ai/init/nested: unexpected non-file entry inside section directory',
    );
  });

  it('throws with the path when a row file has no default export', () => {
    const sec = defineRowSection({
      surface: 'ai',
      order: 10,
      defaults: { section: 'Init', status: 'conforms' },
    });
    const record = sec.row({
      featureKeys: ['getAI'],
      api: 'getAI()',
      behavior: 'Returns handle',
      automation: 'unit-backed',
      evidence: '`unit:instances.test.ts`',
      conformanceTests: ['packages/pyric/test/ai/instances.test.ts'],
    });

    const hostNamedOnly = createVirtualHost({
      directories: {
        '/reg/ai': ['init'],
        '/reg/ai/init': ['section.ts', 'named-only.ts'],
      },
      kinds: {
        '/reg/ai/init': 'directory',
        '/reg/ai/init/section.ts': 'file',
        '/reg/ai/init/named-only.ts': 'file',
      },
      modules: {
        '/reg/ai/init/section.ts': { section: sec },
        '/reg/ai/init/named-only.ts': { row: record },
      },
    });

    expect(() => assembleRegistrySections('/reg/ai', hostNamedOnly)).toThrow(
      "/reg/ai/init/named-only.ts: row file must default-export 'row({ ... })' from './section.ts'",
    );
  });

  it('enforces case-insensitive rowRef uniqueness across sections', () => {
    const first = defineRowSection({
      surface: 'ai',
      order: 10,
      defaults: { section: 'First', status: 'conforms' },
    });
    const second = defineRowSection({
      surface: 'ai',
      order: 20,
      defaults: { section: 'Second', status: 'conforms' },
    });
    const seed = {
      featureKeys: ['getAI'],
      api: 'getAI()',
      behavior: 'Returns handle',
      automation: 'unit-backed' as const,
      evidence: '`unit:instances.test.ts`',
      conformanceTests: ['packages/pyric/test/ai/instances.test.ts'],
    };

    const host = createVirtualHost({
      directories: {
        '/reg/ai': ['first', 'second'],
        '/reg/ai/first': ['section.ts', 'RS1.ts'],
        '/reg/ai/second': ['section.ts', 'rs1.ts'],
      },
      kinds: {
        '/reg/ai/first': 'directory',
        '/reg/ai/first/section.ts': 'file',
        '/reg/ai/first/RS1.ts': 'file',
        '/reg/ai/second': 'directory',
        '/reg/ai/second/section.ts': 'file',
        '/reg/ai/second/rs1.ts': 'file',
      },
      modules: {
        '/reg/ai/first/section.ts': { section: first },
        '/reg/ai/first/RS1.ts': { default: first.row(seed) },
        '/reg/ai/second/section.ts': { section: second },
        '/reg/ai/second/rs1.ts': { default: second.row(seed) },
      },
    });

    expect(() => assembleRegistrySections('/reg/ai', host)).toThrow(
      "/reg/ai/second/rs1.ts: duplicate or case-colliding rowRef 'rs1' for surface 'ai' (already defined at /reg/ai/first/RS1.ts)",
    );
  });

  it('allows distinct surfaces in one registry directory to share a rowRef while rejecting same-surface collisions', () => {
    const clientSection = defineRowSection({
      surface: 'storage',
      order: 10,
      defaults: { section: 'Initializer', status: 'conforms' },
    });
    const adminSection = defineRowSection({
      surface: 'storage-admin',
      order: 20,
      defaults: { section: 'Admin File metadata', status: 'conforms' },
    });
    const adminSecondSection = defineRowSection({
      surface: 'storage-admin',
      order: 30,
      defaults: { section: 'Admin Bucket listing', status: 'conforms' },
    });
    const seed = {
      featureKeys: ['getStorage'],
      api: 'getStorage()',
      behavior: 'Returns handle',
      automation: 'unit-backed' as const,
      evidence: '`unit:service.test.ts`',
      conformanceTests: ['packages/pyric/test/storage/service.test.ts'],
    };

    const distinctSurfaceHost = createVirtualHost({
      directories: {
        '/reg/storage': ['init', 'admin-file'],
        '/reg/storage/init': ['section.ts', '1.ts'],
        '/reg/storage/admin-file': ['section.ts', '1.ts'],
      },
      kinds: {
        '/reg/storage/init': 'directory',
        '/reg/storage/init/section.ts': 'file',
        '/reg/storage/init/1.ts': 'file',
        '/reg/storage/admin-file': 'directory',
        '/reg/storage/admin-file/section.ts': 'file',
        '/reg/storage/admin-file/1.ts': 'file',
      },
      modules: {
        '/reg/storage/init/section.ts': { section: clientSection },
        '/reg/storage/init/1.ts': { default: clientSection.row(seed) },
        '/reg/storage/admin-file/section.ts': { section: adminSection },
        '/reg/storage/admin-file/1.ts': { default: adminSection.row(seed) },
      },
    });

    expect(clientSection.surface).toBe('storage');
    expect(adminSection.surface).toBe('storage-admin');

    const loaded = assembleRegistrySections('/reg/storage', distinctSurfaceHost);
    expect(loaded.rowsOf('init').map((r) => r.id)).toEqual(['storage#1']);
    expect(loaded.rowsOf('admin-file').map((r) => r.id)).toEqual(['storage-admin#1']);

    const sameAdminSurfaceCollisionHost = createVirtualHost({
      directories: {
        '/reg/storage': ['admin-file', 'admin-bucket'],
        '/reg/storage/admin-file': ['section.ts', '1.ts'],
        '/reg/storage/admin-bucket': ['section.ts', '1.ts'],
      },
      kinds: {
        '/reg/storage/admin-file': 'directory',
        '/reg/storage/admin-file/section.ts': 'file',
        '/reg/storage/admin-file/1.ts': 'file',
        '/reg/storage/admin-bucket': 'directory',
        '/reg/storage/admin-bucket/section.ts': 'file',
        '/reg/storage/admin-bucket/1.ts': 'file',
      },
      modules: {
        '/reg/storage/admin-file/section.ts': { section: adminSection },
        '/reg/storage/admin-file/1.ts': { default: adminSection.row(seed) },
        '/reg/storage/admin-bucket/section.ts': { section: adminSecondSection },
        '/reg/storage/admin-bucket/1.ts': { default: adminSecondSection.row(seed) },
      },
    });

    expect(() => assembleRegistrySections('/reg/storage', sameAdminSurfaceCollisionHost)).toThrow(
      "/reg/storage/admin-file/1.ts: duplicate or case-colliding rowRef '1' for surface 'storage-admin' (already defined at /reg/storage/admin-bucket/1.ts)",
    );
  });

  it('rejects stray top-level files, invalid section slugs, empty sections, and inline rowRef/id fields', () => {
    const sec = defineRowSection({
      surface: 'ai',
      order: 10,
      defaults: { section: 'Init', status: 'conforms' },
    });

    expect(() =>
      sec.row({
        featureKeys: ['getAI'],
        api: 'getAI()',
        behavior: 'Returns handle',
        automation: 'unit-backed',
        evidence: '`unit:instances.test.ts`',
        conformanceTests: ['packages/pyric/test/ai/instances.test.ts'],
        rowRef: 'inline-ref' as never,
      }),
    ).toThrow("authored row record must not declare 'rowRef'");

    const hostStrayTopFile = createVirtualHost({
      directories: { '/reg/ai': ['stray.ts'] },
      kinds: { '/reg/ai/stray.ts': 'file' },
      modules: {},
    });
    expect(() => assembleRegistrySections('/reg/ai', hostStrayTopFile)).toThrow(
      '/reg/ai/stray.ts: unexpected non-directory entry in surface registry directory',
    );

    const hostEmptySection = createVirtualHost({
      directories: { '/reg/ai': ['init'], '/reg/ai/init': ['section.ts'] },
      kinds: { '/reg/ai/init': 'directory', '/reg/ai/init/section.ts': 'file' },
      modules: { '/reg/ai/init/section.ts': { section: sec } },
    });
    expect(() => assembleRegistrySections('/reg/ai', hostEmptySection)).toThrow(
      '/reg/ai/init: section contains no row files',
    );
  });

  it('derives rowRef-dependent fields via rowFromRef without repeating rowRef in the row module', () => {
    const fnSection = defineRowSection({
      surface: 'functions-rtdb',
      order: 10,
      defaults: { section: '`firebase-functions/v2/database.onValueCreated`' },
    });

    const host = createVirtualHost({
      directories: {
        '/reg/functions-rtdb': ['on-value-created'],
        '/reg/functions-rtdb/on-value-created': ['section.ts', '2.ts', '1.ts', '9.ts'],
      },
      kinds: {
        '/reg/functions-rtdb/on-value-created': 'directory',
        '/reg/functions-rtdb/on-value-created/section.ts': 'file',
        '/reg/functions-rtdb/on-value-created/1.ts': 'file',
        '/reg/functions-rtdb/on-value-created/2.ts': 'file',
        '/reg/functions-rtdb/on-value-created/9.ts': 'file',
      },
      modules: {
        '/reg/functions-rtdb/on-value-created/section.ts': { section: fnSection },
        '/reg/functions-rtdb/on-value-created/2.ts': {
          default: fnSection.rowFromRef(10, (rowRef) => ({
            featureKeys: ['onValueCreated'],
            api: 'onValueCreated(ref, handler)',
            behavior: 'First ordered row',
            status: 'conforms',
            automation: 'oracle-backed',
            evidence: `assertion set \`functions-rtdb#${rowRef}\``,
            conformanceTests: ['packages/cli/test/functions-rtdb/oracle-conformance.test.ts'],
          })),
        },
        '/reg/functions-rtdb/on-value-created/1.ts': {
          default: fnSection.rowFromRef(20, (rowRef) => ({
            featureKeys: ['onValueCreated'],
            api: 'onValueCreated(ref, handler)',
            behavior: 'Second ordered row',
            status: 'conforms',
            automation: 'oracle-backed',
            evidence: `assertion set \`functions-rtdb#${rowRef}\``,
            conformanceTests: ['packages/cli/test/functions-rtdb/oracle-conformance.test.ts'],
          })),
        },
        '/reg/functions-rtdb/on-value-created/9.ts': {
          default: fnSection.rowFromRef(undefined, (rowRef) => ({
            featureKeys: ['onValueCreated'],
            api: 'onValueCreated(ref, handler)',
            behavior: 'Unordered new row',
            status: 'conforms',
            automation: 'oracle-backed',
            evidence: `assertion set \`functions-rtdb#${rowRef}\``,
            conformanceTests: ['packages/cli/test/functions-rtdb/oracle-conformance.test.ts'],
          })),
        },
      },
    });

    const loaded = assembleRegistrySections('/reg/functions-rtdb', host);
    const rows = loaded.rowsOf('on-value-created');
    expect(rows.map((r) => r.id)).toEqual([
      'functions-rtdb#2',
      'functions-rtdb#1',
      'functions-rtdb#9',
    ]);
    expect(rows.map((r) => r.evidence)).toEqual([
      'assertion set `functions-rtdb#2`',
      'assertion set `functions-rtdb#1`',
      'assertion set `functions-rtdb#9`',
    ]);

    const illegalRecord = fnSection.rowFromRef(10, () => ({
      featureKeys: ['onValueCreated'],
      api: 'onValueCreated(ref, handler)',
      behavior: 'Bad rowRef return',
      status: 'conforms',
      automation: 'oracle-backed',
      evidence: 'bad',
      rowRef: 'inline' as never,
    }));
    expect(() => illegalRecord.build('1')).toThrow("authored row record must not declare 'rowRef'");
  });
});
