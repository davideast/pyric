// Every committed quarantine entry in .github/quarantine/ is well formed,
// named for its test, names one test (or a file only for its unnamed
// failures, or an app) in a suite the quarantine runners cover, and lasts at
// most 14 days from when it was added or last renewed. An expired entry still
// passes: it simply blocks again, and main never turns red on its expiry day.

import { describe, expect, test } from 'bun:test';
import { readEntries } from '../lib/quarantine/entries.ts';
import { validateEntry } from '../lib/quarantine/validate.ts';

describe('committed quarantine entries', () => {
  const entries = readEntries();

  test('every entry is valid', () => {
    const problems = entries.flatMap((entry) => validateEntry(entry, entry.file).map((problem) => `${entry.file}: ${problem}`));
    expect(problems).toEqual([]);
  });
});
