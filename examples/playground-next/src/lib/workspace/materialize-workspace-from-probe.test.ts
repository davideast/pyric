import { describe, expect, test } from 'bun:test';

import { APP_ENTRY_PATH, RULES_PATH } from '~/lib/store/files';
import { createMemoryVFSAdapter } from '~/lib/vfs/memory-adapter';

import { materializeWorkspaceFromProbe } from './materialize-workspace-from-probe';
import type { WorkspaceFileMappings } from './probe-from-repo';

describe('materializeWorkspaceFromProbe', () => {
  test('copies nested clone into canonical paths', async () => {
    const adapter = createMemoryVFSAdapter();
    const mappings: WorkspaceFileMappings = {
      contentRoot: '/workspace/my-app',
      rulesPath: '/workspace/my-app/firestore.rules',
      appEntryPath: '/workspace/my-app/src/App.tsx',
      canonical: { rulesPath: RULES_PATH, appEntryPath: APP_ENTRY_PATH },
      testPaths: ['/workspace/my-app/tests/rules.test.json'],
    };

    await adapter.promises.mkdir('/workspace/my-app/src', { recursive: true });
    await adapter.promises.mkdir('/workspace/my-app/tests', { recursive: true });
    await adapter.promises.writeFile(mappings.rulesPath, 'rules_version = "2";');
    await adapter.promises.writeFile(mappings.appEntryPath, 'export default function App() { return null; }');
    await adapter.promises.writeFile(
      mappings.testPaths[0]!,
      JSON.stringify({ cases: [] }),
    );

    const result = await materializeWorkspaceFromProbe(mappings, adapter);

    expect(result.rules).toBe('rules_version = "2";');
    expect(result.appSource).toContain('export default function App');
    expect(await adapter.promises.readFile(RULES_PATH, 'utf8')).toBe(result.rules);
    expect(await adapter.promises.readFile(APP_ENTRY_PATH, 'utf8')).toBe(result.appSource);
    expect(await adapter.promises.readFile('/workspace/tests/rules.test.json', 'utf8')).toBe(
      JSON.stringify({ cases: [] }),
    );
  });

  test('copies app.spec.json when present', async () => {
    const adapter = createMemoryVFSAdapter();
    const mappings: WorkspaceFileMappings = {
      contentRoot: '/workspace',
      rulesPath: RULES_PATH,
      appEntryPath: APP_ENTRY_PATH,
      canonical: { rulesPath: RULES_PATH, appEntryPath: APP_ENTRY_PATH },
      specPath: '/workspace/app.spec.json',
      testPaths: [],
    };

    await adapter.promises.writeFile(RULES_PATH, 'rules');
    await adapter.promises.writeFile(APP_ENTRY_PATH, 'export default function App() {}');
    await adapter.promises.writeFile(mappings.specPath!, '{"name":"demo"}');

    await materializeWorkspaceFromProbe(mappings, adapter);

    expect(await adapter.promises.readFile('/workspace/app.spec.json', 'utf8')).toBe('{"name":"demo"}');
  });
});
