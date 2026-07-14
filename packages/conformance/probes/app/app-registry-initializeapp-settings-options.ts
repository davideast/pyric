import { initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    'firebase/app snapshots FirebaseOptions, accepts FirebaseAppSettings, initializes automaticDataCollectionEnabled from settings, and leaves that app property mutable.',
  matrixRow: 'app #16',
  rowIds: ['app#16'],
  async observe() {
    const input = { ...OPTS };
    const app = initializeApp(input, { name: 'settings-app', automaticDataCollectionEnabled: false });
    const optionsSameReference = app.options === input;
    input.projectId = 'mutated-after-initialize';
    const projectIdAfterInputMutation = app.options.projectId;
    const initialAutomaticDataCollectionEnabled = app.automaticDataCollectionEnabled;
    app.automaticDataCollectionEnabled = true;
    return {
      name: app.name,
      optionsSameReference,
      optionsFrozen: Object.isFrozen(app.options),
      projectIdAfterInputMutation,
      initialAutomaticDataCollectionEnabled,
      automaticDataCollectionEnabledAfterMutation: app.automaticDataCollectionEnabled,
    };
  },
};
