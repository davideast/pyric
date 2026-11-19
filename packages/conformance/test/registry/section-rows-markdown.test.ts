import { describe, expect, it } from 'bun:test';
import {
  assembleRegistrySections,
  defineMarkdownSection,
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

describe('defineMarkdownSection and contentBlocks assembly', () => {
  it('sorts interleaved markdown and table sections by order without altering table-only blocks', () => {
    const emulatorSection = defineRowSection({
      surface: 'firestore',
      order: 200,
      defaults: {
        section: '`connectFirestoreEmulator`',
        api: 'connectFirestoreEmulator',
        status: 'conforms',
      },
    });
    const offlineHeading = defineMarkdownSection({
      order: 210,
      markdown: '\n## Offline / persistence / network family\n',
    });
    const offlineTable = defineRowSection({
      surface: 'firestore',
      order: 220,
      prefix: '## Offline / persistence / network family (continued)\n',
      defaults: {
        section: 'Offline / persistence / network family',
        automation: 'unit-backed',
      },
    });

    const host = createVirtualHost({
      directories: {
        '/reg/firestore': ['offline-persistence', 'offline-persistence-heading', 'emulator'],
        '/reg/firestore/emulator': ['section.ts', '120.ts'],
        '/reg/firestore/offline-persistence-heading': ['section.ts'],
        '/reg/firestore/offline-persistence': ['section.ts', '140.ts'],
      },
      kinds: {
        '/reg/firestore/emulator': 'directory',
        '/reg/firestore/emulator/section.ts': 'file',
        '/reg/firestore/emulator/120.ts': 'file',
        '/reg/firestore/offline-persistence-heading': 'directory',
        '/reg/firestore/offline-persistence-heading/section.ts': 'file',
        '/reg/firestore/offline-persistence': 'directory',
        '/reg/firestore/offline-persistence/section.ts': 'file',
        '/reg/firestore/offline-persistence/140.ts': 'file',
      },
      modules: {
        '/reg/firestore/emulator/section.ts': { section: emulatorSection },
        '/reg/firestore/emulator/120.ts': {
          default: emulatorSection.row({
            featureKeys: ['connectFirestoreEmulator'],
            behavior: 'Connects to emulator',
            automation: 'unit-backed',
            evidence: '`unit:emulator.test.ts`',
            conformanceTests: ['packages/pyric/test/firestore/emulator.test.ts'],
          }),
        },
        '/reg/firestore/offline-persistence-heading/section.ts': { section: offlineHeading },
        '/reg/firestore/offline-persistence/section.ts': { section: offlineTable },
        '/reg/firestore/offline-persistence/140.ts': {
          default: offlineTable.row({
            featureKeys: ['enableNetwork'],
            api: 'enableNetwork(db)',
            behavior: 'Resolves void',
            status: 'conforms',
            evidence: '`unit:network.test.ts`',
            conformanceTests: ['packages/pyric/test/firestore/network.test.ts'],
          }),
        },
      },
    });

    const loaded = assembleRegistrySections('/reg/firestore', host);
    expect(loaded.blocks).toHaveLength(2);
    expect(loaded.blocks.map((b) => b.rows[0]?.id)).toEqual(['firestore#120', 'firestore#140']);

    expect(loaded.contentBlocks).toHaveLength(3);
    expect(loaded.contentBlocks[0]?.kind).toBe('table');
    expect(loaded.contentBlocks[1]).toEqual({
      kind: 'markdown',
      markdown: '\n## Offline / persistence / network family\n',
    });
    expect(loaded.contentBlocks[2]?.kind).toBe('table');
    expect(() => loaded.rowsOf('offline-persistence-heading')).toThrow(
      "unknown registry section 'offline-persistence-heading'",
    );
  });

  it('validates defineMarkdownSection inputs and rejects extra files inside a markdown section directory', () => {
    expect(() => defineMarkdownSection({ order: Number.NaN, markdown: '## Title\n' })).toThrow(
      "defineMarkdownSection: 'order' must be a finite number",
    );
    expect(() => defineMarkdownSection({ order: 10, markdown: '   ' })).toThrow(
      "defineMarkdownSection: 'markdown' must be a non-empty string",
    );

    const mdSection = defineMarkdownSection({ order: 10, markdown: '## Heading\n' });
    const hostWithExtraFile = createVirtualHost({
      directories: {
        '/reg/firestore': ['heading'],
        '/reg/firestore/heading': ['section.ts', '1.ts'],
      },
      kinds: {
        '/reg/firestore/heading': 'directory',
        '/reg/firestore/heading/section.ts': 'file',
        '/reg/firestore/heading/1.ts': 'file',
      },
      modules: {
        '/reg/firestore/heading/section.ts': { section: mdSection },
      },
    });

    expect(() => assembleRegistrySections('/reg/firestore', hostWithExtraFile)).toThrow(
      '/reg/firestore/heading/1.ts: markdown section directory must contain only section.ts',
    );
  });
});
