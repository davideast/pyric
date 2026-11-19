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

describe('section-rows row filename validation', () => {
  const storageRulesSection = defineRowSection({
    surface: 'storage-rules',
    order: 10,
    defaults: {
      section: 'Storage rules engine',
      api: 'Rules',
      status: 'conforms',
      automation: 'oracle-backed',
    },
  });

  const sampleSeed = {
    featureKeys: ['evaluateStorageRules'],
    behavior: 'Evaluates dotted construct row cleanly',
    evidence: '`oracle:rules-storage-stdlib`',
    oracleObservations: ['rules-storage-stdlib'],
    conformanceTests: ['packages/rules/test/storage/rules-oracle-conformance.test.ts'],
  };

  it('loads dotted rowRef filenames such as storage-rules stdlib and semantic rows', () => {
    const dottedStems = [
      'storage.semantic.strict-boolean-allow-boundary',
      'storage.stdlib.timestamp-duration',
      'storage.stdlib.map-diff',
    ];
    const sectionEntries = ['section.ts', ...dottedStems.map((stem) => `${stem}.ts`)];
    const kinds: Record<string, RegistryEntryKind> = {
      '/reg/rules/storage-rules': 'directory',
      '/reg/rules/storage-rules/section.ts': 'file',
    };
    const modules: Record<string, unknown> = {
      '/reg/rules/storage-rules/section.ts': { section: storageRulesSection },
    };

    for (let idx = 0; idx < dottedStems.length; idx += 1) {
      const stem = dottedStems[idx];
      if (stem === undefined) continue;
      const path = `/reg/rules/storage-rules/${stem}.ts`;
      kinds[path] = 'file';
      modules[path] = {
        default: storageRulesSection.row({
          ...sampleSeed,
          order: (idx + 1) * 10,
        }),
      };
    }

    const host = createVirtualHost({
      directories: {
        '/reg/rules': ['storage-rules'],
        '/reg/rules/storage-rules': sectionEntries,
      },
      kinds,
      modules,
    });

    const loaded = assembleRegistrySections('/reg/rules', host);
    const rows = loaded.rowsOf('storage-rules');
    expect(rows.map((row) => row.rowRef)).toEqual(dottedStems);
    expect(rows.map((row) => row.id)).toEqual([
      'storage-rules#storage.semantic.strict-boolean-allow-boundary',
      'storage-rules#storage.stdlib.timestamp-duration',
      'storage-rules#storage.stdlib.map-diff',
    ]);
  });

  it('rejects .test.ts, .spec.ts, .d.ts, and .generated.ts suffixes case-insensitively', () => {
    const forbiddenNames = [
      '1.test.ts',
      '1.TEST.TS',
      'row.spec.ts',
      'row.Spec.ts',
      'types.d.ts',
      'types.D.TS',
      'rows.generated.ts',
      'rows.Generated.ts',
    ];

    for (const fileName of forbiddenNames) {
      const filePath = `/reg/rules/storage-rules/${fileName}`;
      const host = createVirtualHost({
        directories: {
          '/reg/rules': ['storage-rules'],
          '/reg/rules/storage-rules': ['section.ts', fileName],
        },
        kinds: {
          '/reg/rules/storage-rules': 'directory',
          '/reg/rules/storage-rules/section.ts': 'file',
          [filePath]: 'file',
        },
        modules: {
          '/reg/rules/storage-rules/section.ts': { section: storageRulesSection },
        },
      });

      expect(() => assembleRegistrySections('/reg/rules', host)).toThrow(
        `${filePath}: invalid row filename '${fileName}'`,
      );
    }
  });

  it('rejects leading, trailing, or consecutive dots and adjacent dot-hyphen separators', () => {
    const malformedNames = [
      '.hidden.ts',
      'trailing..ts',
      'double..dot.ts',
      'dot.-hyphen.ts',
      'hyphen-.dot.ts',
    ];

    for (const fileName of malformedNames) {
      const filePath = `/reg/rules/storage-rules/${fileName}`;
      const host = createVirtualHost({
        directories: {
          '/reg/rules': ['storage-rules'],
          '/reg/rules/storage-rules': ['section.ts', fileName],
        },
        kinds: {
          '/reg/rules/storage-rules': 'directory',
          '/reg/rules/storage-rules/section.ts': 'file',
          [filePath]: 'file',
        },
        modules: {
          '/reg/rules/storage-rules/section.ts': { section: storageRulesSection },
        },
      });

      expect(() => assembleRegistrySections('/reg/rules', host)).toThrow(
        `${filePath}: invalid row filename '${fileName}'`,
      );
    }
  });
});
