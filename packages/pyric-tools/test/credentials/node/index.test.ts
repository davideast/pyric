import { describe, expect, it } from 'bun:test';

import * as nodeCredentials from '../../../src/credentials/node/index.js';

describe('@pyric/cli/credentials/node', () => {
  it('exports only the sources supported by Rules Test API verification', () => {
    expect(Object.keys(nodeCredentials).sort()).toEqual([
      'fromAdc',
      'fromServiceAccount',
    ]);
  });
});
