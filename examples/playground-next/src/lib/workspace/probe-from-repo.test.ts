import { describe, expect, test } from 'bun:test';

import { APP_ENTRY_PATH, RULES_PATH, WORKSPACE_ROOT } from '~/lib/store/files';

import {
  analyzePackageJson,
  detectContentRoot,
  discoverAppEntry,
  discoverRulesPath,
  probeWorkspaceFiles,
  scanEntryImports,
} from './probe-from-repo';

const readMap =
  (files: Record<string, string>) =>
  async (path: string): Promise<string | null> =>
    files[path] ?? null;

describe('detectContentRoot', () => {
  test('uses workspace root when markers sit at canonical paths', () => {
    const files = [RULES_PATH, APP_ENTRY_PATH, '/workspace/package.json'];
    expect(detectContentRoot(files, WORKSPACE_ROOT)).toBe(WORKSPACE_ROOT);
  });

  test('detects nested clone directory', () => {
    const files = [
      '/workspace/my-app/firestore.rules',
      '/workspace/my-app/src/App.tsx',
      '/workspace/my-app/package.json',
    ];
    expect(detectContentRoot(files, WORKSPACE_ROOT)).toBe('/workspace/my-app');
  });
});

describe('discoverRulesPath', () => {
  test('finds rules at content root', () => {
    expect(
      discoverRulesPath(['/workspace/my-app/firestore.rules'], '/workspace/my-app'),
    ).toBe('/workspace/my-app/firestore.rules');
  });
});

describe('discoverAppEntry', () => {
  test('prefers src/App.tsx', () => {
    const hit = discoverAppEntry(
      ['/workspace/src/App.tsx', '/workspace/public/app.js'],
      WORKSPACE_ROOT,
    );
    expect(hit?.path).toBe('/workspace/src/App.tsx');
    expect(hit?.kind).toBe('playground-native');
  });

  test('finds playground-template entry', () => {
    const hit = discoverAppEntry(
      ['/workspace/src/generated/app-source.tsx'],
      WORKSPACE_ROOT,
    );
    expect(hit?.kind).toBe('playground-template');
  });
});

describe('analyzePackageJson', () => {
  test('blocks Next.js dependency', () => {
    const { blockers } = analyzePackageJson(
      JSON.stringify({ dependencies: { next: '15.0.0', react: '18.0.0' } }),
    );
    expect(blockers.some((b) => b.includes('next'))).toBe(true);
  });

  test('warns when firebase is missing', () => {
    const { warnings } = analyzePackageJson(JSON.stringify({ dependencies: { react: '18' } }));
    expect(warnings.some((w) => w.includes('firebase'))).toBe(true);
  });
});

describe('scanEntryImports', () => {
  test('blocks node: imports', () => {
    const { blockers } = scanEntryImports(`import fs from 'node:fs'; export default function App() {}`);
    expect(blockers.length).toBeGreaterThan(0);
  });

  test('allows firebase and react imports', () => {
    const { blockers, warnings } = scanEntryImports(`
      import { useState } from 'react';
      import { collection } from 'firebase/firestore';
      export default function App() { return null; }
    `);
    expect(blockers).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('warns on unknown bare specifier', () => {
    const { warnings } = scanEntryImports(`
      import lodash from 'lodash-es';
      export default function App() { return null; }
    `);
    expect(warnings.some((w) => w.includes('lodash-es'))).toBe(true);
  });
});

describe('probeWorkspaceFiles', () => {
  test('green for canonical playground layout', async () => {
    const files = [
      RULES_PATH,
      APP_ENTRY_PATH,
      '/workspace/package.json',
      '/workspace/tests/demo.test.json',
      '/workspace/app.spec.json',
    ];
    const result = await probeWorkspaceFiles(files, {
      readFile: readMap({
        [RULES_PATH]: 'rules_version = "2";',
        [APP_ENTRY_PATH]: 'export default function App() { return null; }',
        '/workspace/package.json': JSON.stringify({ dependencies: { firebase: '^12', react: '^18' } }),
      }),
    });
    expect(result.tier).toBe('green');
    expect(result.layout).toBe('playground-native');
    expect(result.blockers).toEqual([]);
    expect(result.mappings?.rulesPath).toBe(RULES_PATH);
    expect(result.mappings?.appEntryPath).toBe(APP_ENTRY_PATH);
    expect(result.mappings?.testPaths).toEqual(['/workspace/tests/demo.test.json']);
  });

  test('yellow for nested clone with native filenames', async () => {
    const root = '/workspace/coffee-shop';
    const rules = `${root}/firestore.rules`;
    const app = `${root}/src/App.tsx`;
    const result = await probeWorkspaceFiles(
      [rules, app, `${root}/package.json`],
      {
        readFile: readMap({
          [rules]: 'rules_version = "2";',
          [app]: 'export default function App() { return null; }',
          [`${root}/package.json`]: JSON.stringify({ dependencies: { firebase: '^12' } }),
        }),
      },
    );
    expect(result.tier).toBe('yellow');
    expect(result.mappings?.contentRoot).toBe(root);
    expect(result.warnings.some((w) => w.includes('flatten'))).toBe(true);
  });

  test('red when rules missing', async () => {
    const result = await probeWorkspaceFiles([APP_ENTRY_PATH], {
      readFile: readMap({
        [APP_ENTRY_PATH]: 'export default function App() { return null; }',
      }),
    });
    expect(result.tier).toBe('red');
    expect(result.blockers.some((b) => b.includes('firestore.rules'))).toBe(true);
    expect(result.mappings).toBeNull();
  });

  test('red for Next.js package.json', async () => {
    const result = await probeWorkspaceFiles(
      [RULES_PATH, APP_ENTRY_PATH, '/workspace/package.json'],
      {
        readFile: readMap({
          [RULES_PATH]: 'rules_version = "2";',
          [APP_ENTRY_PATH]: 'export default function App() { return null; }',
          '/workspace/package.json': JSON.stringify({ dependencies: { next: '15' } }),
        }),
      },
    );
    expect(result.tier).toBe('red');
    expect(result.blockers.some((b) => b.includes('next'))).toBe(true);
  });

  test('red for pyric init web public/app.js entry', async () => {
    const result = await probeWorkspaceFiles(
      ['/workspace/firestore.rules', '/workspace/public/app.js'],
      {
        readFile: readMap({
          '/workspace/firestore.rules': 'rules_version = "2";',
          '/workspace/public/app.js': 'console.log("hi");',
        }),
      },
    );
    expect(result.tier).toBe('red');
    expect(result.blockers.some((b) => b.includes('public/app.js'))).toBe(true);
  });

  test('yellow for playground-template entry path', async () => {
    const app = '/workspace/src/generated/app-source.tsx';
    const result = await probeWorkspaceFiles([RULES_PATH, app], {
      readFile: readMap({
        [RULES_PATH]: 'rules_version = "2";',
        [app]: 'export default function App() { return null; }',
      }),
    });
    expect(result.tier).toBe('yellow');
    expect(result.layout).toBe('playground-template');
  });
});
