import type { EvalTask } from '../types.js';

const OPEN_PROFILE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /profiles/{uid} { allow read, write: if true; }
  }
}`;

const task: EvalTask = {
  id: 'why-is-my-read-count-so-high',
  prompt: 'My Firestore reads feel expensive today. Is anything reading the same document repeatedly?',
  seed: {
    firestoreRules: OPEN_PROFILE_RULES,
    firestore: { 'profiles/alice': { name: 'Alice' } },
  },
  acceptedFirstOperations: ['list_sandbox_activity'],
  assert: (state) => {
    const call = state.calls.find(
      (c) => c.operation === 'list_sandbox_activity' && c.ok,
    );
    if (call === undefined) return 'no list_sandbox_activity call ever succeeded';
    const data = call.data as { incidents?: Array<{ pattern: string }> };
    if (!Array.isArray(data.incidents)) {
      return 'list_sandbox_activity did not read back an incidents array';
    }
    if (data.incidents.some((incident) => incident.pattern !== 'repeated-read')) {
      return 'list_sandbox_activity returned a pattern other than repeated-read for a call about read volume';
    }
    return true;
  },
  tags: ['sandbox', 'read'],
};

export default task;
