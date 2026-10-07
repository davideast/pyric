/**
 * Captures the error envelope a native client receives for a denied sandbox
 * RTDB write: the sandbox rejects the write, and the worker's `serializeError`
 * shapes the rejection exactly as it crosses the bridge. The native denial
 * parsers test against these captured files, never hand-written payloads.
 *
 *   bun run packages/cli/scripts/capture-rtdb-denial-envelope.ts --write
 *
 * Without `--write`, prints the envelope. `test/serve/worker/rtdb-denial-envelope.test.ts`
 * fails when a committed copy differs from a fresh capture.
 */
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, sandbox as rtdbSandbox } from 'pyric/database';
import { serializeError } from '../src/serve/worker/protocol.js';

const ROOT = new URL('../../', import.meta.url);

/** Committed copies of the envelope, one per native test tree. */
export const RTDB_DENIAL_ENVELOPE_FILES = [
  'flutter-client/test/fixtures/rtdb-denial-envelope.json',
  'swift-client/Tests/PyricDebugUITests/Fixtures/rtdb-denial-envelope.json',
  'kt-client/debug-compose/src/test/resources/rtdb-denial-envelope.json',
].map((path) => new URL(path, ROOT));

export async function captureRtdbDenialEnvelope(): Promise<unknown> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({
    uid: 'alice',
    tenant: 'tenant-a',
    token: { role: 'viewer', firebase: { tenant: 'tenant-a' } },
  }));
  rtdbSandbox.setRules(db, {
    rules: {
      rooms: {
        $roomId: {
          '.read': 'true',
          '.write': "auth.uid == $roomId || auth.token.role == 'editor'",
        },
      },
    },
  });
  try {
    await set(ref(db, 'rooms/bob/title'), { text: 'Renamed', by: 'alice' });
  } catch (error) {
    return serializeError(error);
  }
  throw new Error('the capture write was expected to be denied');
}

export function envelopeJson(envelope: unknown): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

if (import.meta.main) {
  const json = envelopeJson(await captureRtdbDenialEnvelope());
  if (process.argv.includes('--write')) {
    for (const file of RTDB_DENIAL_ENVELOPE_FILES) {
      await Bun.write(file, json);
      console.log(`wrote ${file.pathname}`);
    }
  } else {
    process.stdout.write(json);
  }
}
