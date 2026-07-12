import { SDK_VERSION } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase/app SDK_VERSION is a semver string (the installed firebase client SDK version). The environment-independent facts are its type and semver shape; the exact value is pinned by the observation envelope fbSdkVersion and the freshness guard.',
  matrixRow: 'app #11',
  rowIds: ['app#11'],
  async observe() {
    return {
      type: typeof SDK_VERSION,
      isSemver: /^\d+\.\d+\.\d+/.test(SDK_VERSION),
      value: SDK_VERSION,
    };
  },
};
