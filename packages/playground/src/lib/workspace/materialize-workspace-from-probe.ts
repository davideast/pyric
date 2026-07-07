/**
 * Copy probed repo files into the canonical playground workspace layout
 * and hydrate the session payload slice (rules + appSource).
 *
 * See plans/clone-from-github.md.
 */
import { notifyVfsWrite } from '~/lib/files/bootstrap';
import {
  APP_ENTRY_PATH,
  RULES_PATH,
  WORKSPACE_ROOT,
} from '~/lib/store/files';
import { getVFS, type OPFSAdapter } from '~/lib/vfs';

import type { WorkspaceFileMappings } from './probe-from-repo';

export interface MaterializedWorkspace {
  rules: string;
  code: string;
  appSource: string;
}

async function readUtf8(adapter: OPFSAdapter, path: string): Promise<string> {
  const raw = await adapter.promises.readFile(path, 'utf8');
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

async function writeUtf8(adapter: OPFSAdapter, path: string, content: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) {
    await adapter.promises.mkdir(dir, { recursive: true });
  }
  await adapter.promises.writeFile(path, content);
}

function testsDestPath(sourcePath: string, contentRoot: string): string {
  const prefix = `${contentRoot}/tests/`;
  if (sourcePath.startsWith(prefix)) {
    return `${WORKSPACE_ROOT}/tests/${sourcePath.slice(prefix.length)}`;
  }
  const base = sourcePath.split('/').pop() ?? sourcePath;
  return `${WORKSPACE_ROOT}/tests/${base}`;
}

/**
 * Map discovered repo paths to canonical `/workspace/…` files and return
 * payload fields for {@link SessionPayload.workspace}.
 */
export async function materializeWorkspaceFromProbe(
  mappings: WorkspaceFileMappings,
  adapter: OPFSAdapter = getVFS(),
): Promise<MaterializedWorkspace> {
  const rules = await readUtf8(adapter, mappings.rulesPath);
  const appSource = await readUtf8(adapter, mappings.appEntryPath);

  await writeUtf8(adapter, RULES_PATH, rules);
  await writeUtf8(adapter, APP_ENTRY_PATH, appSource);
  notifyVfsWrite(RULES_PATH, rules);
  notifyVfsWrite(APP_ENTRY_PATH, appSource);

  if (mappings.specPath) {
    const spec = await readUtf8(adapter, mappings.specPath);
    const dest = `${WORKSPACE_ROOT}/app.spec.json`;
    await writeUtf8(adapter, dest, spec);
  }

  for (const testPath of mappings.testPaths) {
    const testContent = await readUtf8(adapter, testPath);
    await writeUtf8(adapter, testsDestPath(testPath, mappings.contentRoot), testContent);
  }

  return { rules, code: '', appSource };
}
