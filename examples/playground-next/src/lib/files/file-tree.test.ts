import { describe, expect, test } from 'bun:test';

import { listAllFiles } from '~/lib/files/file-tree';
import { WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS, resetVFS } from '~/lib/vfs';

describe('listAllFiles', () => {
  test('returns empty list when root directory does not exist', async () => {
    resetVFS();
    expect(await listAllFiles(WORKSPACE_ROOT)).toEqual([]);
    expect(getVFS()).toBeDefined();
  });
});
