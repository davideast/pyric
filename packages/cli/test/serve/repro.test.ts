import { describe, expect, test } from 'bun:test';
import { IdBindings, matchRecorded, normalize, TIME } from '../../src/serve/repro/compare.js';
import { parseRepro, redactSecrets, REDACTED_SECRET, restoreRedactedTokens } from '../../src/serve/repro/format.js';
import { createReproRecorder } from '../../src/serve/repro/recorder.js';
import { runServeReproCapture, runServeReproReplay } from '../../src/cli/serve-repro.js';
import type { ReproBase } from '../../src/serve/repro/format.js';
import type { InboundMessage } from '../../src/serve/worker/protocol.js';
import { parseArgs } from '../../src/cli/parse-args.js';

const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
const signed = `${encode({ alg: 'RS256', kid: 'k1' })}.${encode({ sub: 'alice', iat: 1, admin: true })}.c2lnbmF0dXJlLWJ5dGVz`;

describe('repro secrets', () => {
  test('a JSON Web Token keeps its header and claims and loses its signature', () => {
    const redacted = redactSecrets({ customToken: signed, nested: [signed] });
    const marker = { __redactedJwt: { header: { alg: 'RS256', kid: 'k1' }, claims: { sub: 'alice', iat: 1, admin: true } } };
    expect(redacted).toEqual({ customToken: marker, nested: [marker] });
    expect(JSON.stringify(redacted)).not.toContain('c2lnbmF0dXJlLWJ5dGVz');
  });

  test('private keys and service account records are removed', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n';
    expect(redactSecrets({ pem: key, privateKey: 'abc', account: { type: 'service_account', client_email: 'a@b', private_key: key } }))
      .toEqual({ pem: REDACTED_SECRET, privateKey: REDACTED_SECRET, account: REDACTED_SECRET });
  });

  test('a dotted string that is not a token is kept', () => {
    expect(redactSecrets('users.alice.profile')).toBe('users.alice.profile');
  });

  test('replay turns a redacted token back into an unsigned token with the same claims', () => {
    const restored = restoreRedactedTokens(redactSecrets({ customToken: signed })) as { customToken: string };
    const [header, claims, signature] = restored.customToken.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', kid: 'k1' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ sub: 'alice', iat: 1, admin: true });
    expect(signature).toBe('');
  });
});

describe('repro comparison', () => {
  test('a generated id is bound once and later frames use the replayed id', () => {
    const bindings = new IdBindings();
    const recorded = { user: { uid: 'anonymous-0a1b2c3d4e5f6a7b8c9d' } };
    const replayed = { user: { uid: 'anonymous-9f8e7d6c5b4a3f2e1d0c' } };
    expect(matchRecorded(recorded, replayed, bindings).matches).toBe(true);
    expect(bindings.toReplay({ path: 'users/anonymous-0a1b2c3d4e5f6a7b8c9d/name' }))
      .toEqual({ path: 'users/anonymous-9f8e7d6c5b4a3f2e1d0c/name' });
  });

  test('a push key is bound from the one object key each side holds alone', () => {
    const bindings = new IdBindings();
    const recorded = { value: { seeded: { by: 'seed' }, '-OAbcdEFGhij0123456': { by: 'a' } } };
    const replayed = { value: { seeded: { by: 'seed' }, '-OZyxwVUTsrq9876543': { by: 'a' } } };
    expect(matchRecorded(recorded, replayed, bindings).matches).toBe(true);
  });

  test('a changed word is a divergence, not a binding', () => {
    const bindings = new IdBindings();
    expect(matchRecorded({ value: 'first' }, { value: 'second' }, bindings).matches).toBe(false);
    expect(matchRecorded({ name: 'b' }, { name: 'corrupted' }, bindings).matches).toBe(false);
  });

  test('a recorded id bound to two replayed ids is a divergence', () => {
    const bindings = new IdBindings();
    expect(matchRecorded({ id: 'AbCdEfGhIjKlMnOpQr12' }, { id: 'ZyXwVuTsRqPoNmLkJi98' }, bindings).matches).toBe(true);
    expect(matchRecorded({ id: 'AbCdEfGhIjKlMnOpQr12' }, { id: 'QqQqQqQqQqQqQqQqQq77' }, bindings).matches).toBe(false);
  });

  test('times compare equal to times', () => {
    expect(normalize({ at: 1_760_000_000_000, ts: { seconds: 1, nanoseconds: 2 }, iso: '2026-10-08T12:00:00.000Z', iat: 5 }))
      .toEqual({ at: TIME, iat: TIME, iso: TIME, ts: TIME });
    expect(normalize('{"createdAt":1760000000000}')).toEqual({ json: { createdAt: TIME } });
  });
});

function base(): Omit<ReproBase, 'subscriptions'> {
  return {
    at: 0,
    checkpoint: { format: 'pyric-checkpoint-v1', at: 0, counts: { firestore: 0, database: 0, storage: 0, auth: 0 }, state: {} } as never,
    databaseInstances: {}, rules: { firestore: null, database: {}, storage: null },
    defaultInstance: '(default)', permissive: false, appOptions: null, sessions: {},
  };
}

describe('repro recorder', () => {
  test('a full window opens a new one with the listeners still open, and drops the window before it', async () => {
    let captures = 0;
    const recorder = createReproRecorder({ limit: 2, capture: async () => { captures++; return base(); } });
    const op = (id: string) => ({ t: 'op', id, method: 'rtdb.get', path: 'a' }) as InboundMessage;
    await recorder.inbound('tab', { t: 'sub', subId: 's1', target: { service: 'rtdb', path: 'a' } } as InboundMessage);
    await recorder.inbound('tab', op('1'));
    await recorder.inbound('tab', op('2'));
    await recorder.inbound('tab', { t: 'unsub', subId: 's1' } as InboundMessage);
    await recorder.inbound('tab', op('3'));
    const log = await recorder.log();
    expect(captures).toBe(3);
    expect(log.truncated).toBe(true);
    expect(log.entries.map((entry) => entry.kind === 'in' ? entry.frame.t : '')).toEqual(['op', 'unsub', 'op']);
    expect(log.base.subscriptions.tab?.map((frame) => frame.t === 'sub' ? frame.subId : '')).toEqual(['s1']);
  });

  test('Studio event streams and clock frames are not recorded', async () => {
    const recorder = createReproRecorder({ capture: async () => base() });
    await recorder.inbound('studio', { t: 'sub', subId: 'e', target: 'events' } as InboundMessage);
    await recorder.inbound('studio', { t: 'clock-subscribe' } as InboundMessage);
    expect((await recorder.log()).entries).toEqual([]);
  });
});

describe('pyric serve repro', () => {
  const output = () => {
    let text = '';
    return { write: (value: string) => { text += value; }, text: () => text };
  };

  test('capture without a running Node host says how to start one', async () => {
    const err = output();
    const code = await runServeReproCapture(parseArgs(['serve', 'repro', 'capture', '--out', `/nonexistent-${Date.now()}/r.json`]), {
      stderr: err, stdout: output(), discover: async () => null,
    });
    expect(code).toBe(2);
    expect(err.text()).toContain('no running Node host found');
  });

  test('capture asks the discovered host instance for its repro and writes it', async () => {
    const { mkdtempSync, readFileSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-repro-cli-')));
    let request: unknown;
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        request = { path: new URL(incoming.url).pathname, body: await incoming.json() };
        return Response.json({ schema: 'pyric.repro.v1', entries: [1, 2, 3], truncated: false });
      },
    });
    try {
      const out = output();
      const code = await runServeReproCapture(parseArgs(['serve', 'repro', 'capture', '--out', 'bug.json']), {
        cwd: directory, stdout: out, stderr: output(),
        discover: async () => ({ base: `http://127.0.0.1:${server.port}`, instanceId: 'host-1', url: '', mcpUrl: '', source: 'test' }),
      });
      expect(code).toBe(0);
      expect(request).toEqual({ path: '/__pyric/hosted/repro', body: { instanceId: 'host-1', projectDir: directory } });
      expect(JSON.parse(readFileSync(join(directory, 'bug.json'), 'utf8')).entries).toEqual([1, 2, 3]);
      expect(out.text()).toContain('Wrote 3 log entries');
    } finally {
      server.stop(true);
    }
  });

  test('replay refuses a file that is not a repro', async () => {
    expect(() => parseRepro({ schema: 'pyric.verify.fixture.v1' })).toThrow('Not a pyric.repro.v1 file');
    const err = output();
    const code = await runServeReproReplay(parseArgs(['serve', 'repro', 'replay', 'package.json', '--plane', 'browser']), { stderr: err, stdout: output() });
    expect(code).toBe(2);
    expect(err.text()).toContain("--plane is 'node' or 'worker'");
  });
});
