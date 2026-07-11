import { initializeApp } from 'firebase-admin/app';
import type { Probe } from '../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase-admin 13.10 initializeApp is idempotent for identical re-init: calling initializeApp() twice (no args) returns the same [DEFAULT] app WITHOUT throwing, and initializeApp(sameOptions, name) twice returns the same named app without throwing. rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    let reinitNoArgThrew = false;
    let reinitNoArgName: string | undefined;
    try {
      initializeApp();
      const b = initializeApp();
      reinitNoArgName = b.name;
    } catch {
      reinitNoArgThrew = true;
    }

    let reinitSameOptionsThrew = false;
    let reinitSameOptionsName: string | undefined;
    try {
      initializeApp({ databaseURL: 'https://a.firebaseio.com' }, 'app1');
      const d = initializeApp({ databaseURL: 'https://a.firebaseio.com' }, 'app1');
      reinitSameOptionsName = d.name;
    } catch {
      reinitSameOptionsThrew = true;
    }

    return { reinitNoArgThrew, reinitNoArgName, reinitSameOptionsThrew, reinitSameOptionsName };
  },
};
