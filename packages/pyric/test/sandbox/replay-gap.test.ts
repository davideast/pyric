import { expect, test } from 'bun:test';
import { replay as replayDatabase } from '../../src/rules/internal/rtdb.js';
import { replay, type SandboxEvent } from '../../src/sandbox/index.js';

for (const reason of ['history-limit', 'frame-limit'] as const) {
  test(`replay refuses ${reason} before claiming complete verification`, () => {
    const events: SandboxEvent[] = [{
      kind: 'observation_gap', id: 'gap', at: 0, reason,
      omittedCount: 1, firstEventId: 'missing', lastEventId: 'missing',
    }];
    expect(() => replay(events, 'service cloud.firestore { match /{path=**} { allow read, write: if true; } }'))
      .toThrow('Cannot replay or verify incomplete observation history');
  });
}

for (const reason of ['history-limit', 'frame-limit'] as const) {
  test(`RTDB replay refuses ${reason} before claiming complete verification`, async () => {
    const events: SandboxEvent[] = [{
      kind: 'observation_gap', id: 'gap', at: 0, reason,
      omittedCount: 1, firstEventId: 'missing', lastEventId: 'missing',
    }];
    await expect(replayDatabase(events, { rules: { rules: { '.read': true, '.write': true } } }))
      .rejects.toThrow('Cannot replay or verify incomplete observation history');
  });
}
