/**
 * The native denial parsers test against a captured RTDB denial envelope.
 * Each committed copy must equal a fresh capture from the sandbox through the
 * worker's `serializeError`; regenerate with
 * `bun run packages/cli/scripts/capture-rtdb-denial-envelope.ts --write`.
 */
import { expect, test } from 'bun:test';
import {
  RTDB_DENIAL_ENVELOPE_FILES,
  captureRtdbDenialEnvelope,
  envelopeJson,
} from '../../../scripts/capture-rtdb-denial-envelope.js';

test('committed native RTDB denial envelopes match a fresh sandbox capture', async () => {
  const fresh = envelopeJson(await captureRtdbDenialEnvelope());
  expect(JSON.parse(fresh)).toMatchObject({
    code: 'PERMISSION_DENIED',
    denialContext: { engine: 'rtdb', request: { method: 'set', path: '/rooms/bob/title' } },
  });
  for (const file of RTDB_DENIAL_ENVELOPE_FILES) {
    expect(await Bun.file(file).text(), file.pathname).toBe(fresh);
  }
});
