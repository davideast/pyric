import { registerVersion } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase/app registerVersion(library, version) accepts a well-formed library/version pair without throwing and returns undefined (its observable effect is registering a platform-logger version component; the return contract is what a mirror can assert).',
  matrixRow: 'app #14',
  rowIds: ['app#14'],
  async observe() {
    let threw = false;
    let returnedUndefined = false;
    try {
      const ret = registerVersion('pyric-probe-lib', '1.2.3');
      returnedUndefined = ret === undefined;
    } catch {
      threw = true;
    }
    return { threw, returnedUndefined };
  },
};
