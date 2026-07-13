import { describe, expect, it } from 'bun:test';

import type { ProjectScope } from '../../src/credentials/index.js';
import { fromServiceAccount } from '../../src/credentials/node/index.js';

describe('@pyric/cli credential surface', () => {
  it('builds a frozen project scope from service-account JSON without resolving a token', async () => {
    const scope: ProjectScope = await fromServiceAccount(
      JSON.stringify({
        client_email: 'ci@example.test',
        private_key: 'unused until resolveToken is called',
        project_id: 'demo-project',
      }),
    );

    expect(scope.projectId).toBe('demo-project');
    expect(typeof scope.resolveToken).toBe('function');
    expect(Object.isFrozen(scope)).toBe(true);
  });
});
