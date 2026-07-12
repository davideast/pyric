import { expect, test } from 'bun:test';
import { ALL_RULES_RTDB_SCENARIOS } from '../rules-corpus/rtdb/index.ts';
import { replayRtdbScenario } from './rules-rtdb-replay.ts';

test('replays one RTDB corpus scenario through the local simulator', () => {
  const scenario = ALL_RULES_RTDB_SCENARIOS.find((candidate) => candidate.id === 'r1-auth-only');
  expect(scenario).toBeDefined();
  if (!scenario) return;

  expect(replayRtdbScenario(scenario)).toEqual([
    {
      caseKey: 'authed read allowed',
      production: 'ALLOW',
      simulator: 'ALLOW',
    },
    {
      caseKey: 'authed write allowed',
      production: 'ALLOW',
      simulator: 'ALLOW',
    },
    {
      caseKey: 'anon read denied',
      production: 'DENY',
      simulator: 'DENY',
    },
    {
      caseKey: 'anon write denied',
      production: 'DENY',
      simulator: 'DENY',
    },
  ]);
});

test('applies mount-relative seed data before replaying a case', () => {
  expect(replayRtdbScenario({
    id: 'seeded-replay',
    fm: 'rtdb#71',
    rationale: 'A sibling membership lookup sees pre-existing data.',
    provenance: 'Synthetic replay-adapter specification.',
    rules: JSON.stringify({
      rooms: {
        r1: {
          members: {},
          messages: {
            $messageId: {
              '.write': "auth != null && data.parent().parent().child('members').hasChild(auth.uid)",
            },
          },
        },
      },
    }),
    cases: [
      {
        description: 'member write sees the seeded sibling membership',
        expectation: 'ALLOW',
        operation: 'write',
        opPath: '/rooms/r1/messages/m1',
        authPresent: true,
        seed: { '/rooms/r1/members/<UID>': true },
        newData: { text: 'hello' },
      },
    ],
  })).toEqual([
    {
      caseKey: 'member write sees the seeded sibling membership',
      production: 'ALLOW',
      simulator: 'ALLOW',
    },
  ]);
});
