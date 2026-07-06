import { describe, expect, test } from 'bun:test';

import { extractJsonText, parseSeedProposal } from './parse';

const VALID = {
  version: 1,
  summary: 'Coffee shop demo',
  firestore: {
    menuItems: {
      latte: { name: 'Latte', price: 5 },
    },
  },
  auth: [{ uid: 'alice', email: 'alice@test.dev' }],
};

describe('extractJsonText', () => {
  test('strips markdown fence', () => {
    expect(extractJsonText('```json\n{"version":1}\n```')).toBe('{"version":1}');
  });
});

describe('parseSeedProposal', () => {
  test('accepts valid proposal', () => {
    const result = parseSeedProposal(JSON.stringify(VALID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.firestore.menuItems).toBeTruthy();
    }
  });

  test('rejects missing firestore collections', () => {
    const result = parseSeedProposal(JSON.stringify({ version: 1, firestore: {} }));
    expect(result.ok).toBe(false);
  });

  test('rejects invalid json', () => {
    expect(parseSeedProposal('{ not json').ok).toBe(false);
  });
});
