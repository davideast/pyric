/**
 * Capture M's cleanup deletes both restricted API keys and the client state
 * whatever failed before it, reads each back, and reports a failure as an
 * invariant, not a throw. The writer refuses a recording with a token left in
 * it. The API Keys API and the browser are fakes; nothing reaches the network.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  announceRunId,
  keyId,
  payloadShape,
  recordExchange,
  Redactor,
  runWithCaptureCleanup,
  SecretCollector,
  writeMessagingRecording,
  type ApiKeyEntry,
  type ApiKeys,
  type ClientReadBack,
  type CreatedKey,
  type KeyRestriction,
} from '../../../../src/capture/messaging-live/live-capture.ts';

const RUN = '1762400000000-abc123';

interface FakeKeys {
  keys: ApiKeys;
  live: Map<string, ApiKeyEntry>;
  deleted: Set<string>;
}

/** A fake API Keys API; `failRemove` makes one key's delete reject, `failCreate` the second create. */
function fakeKeys(options: { failRemove?: KeyRestriction; failCreate?: boolean; preexisting?: boolean } = {}): FakeKeys {
  const live = new Map<string, ApiKeyEntry>();
  const deleted = new Set<string>();
  if (options.preexisting) live.set('keys/old', { name: 'keys/old', displayName: `pyric capture m ${RUN} referrer-blocked` });
  const keys: ApiKeys = {
    async list(runId) {
      return [...live.values()].filter((k) => k.displayName.includes(runId));
    },
    async create(runId, restriction): Promise<CreatedKey> {
      if (options.failCreate && restriction === 'installations-only') {
        live.set(`keys/${keyId(runId, restriction)}`, { name: `keys/${keyId(runId, restriction)}`, displayName: `pyric capture m ${runId} ${restriction}` });
        throw new Error('operation timed out after creating the key');
      }
      const key = { name: `keys/${keyId(runId, restriction)}`, displayName: `pyric capture m ${runId} ${restriction}`, restriction, keyString: `secret-${restriction}` };
      live.set(key.name, key);
      return key;
    },
    async remove(name) {
      if (options.failRemove && name.endsWith(options.failRemove === 'referrer-blocked' ? '-ref' : '-fis')) throw new Error('delete answered 500');
      live.delete(name);
      deleted.add(name);
    },
    async isDeleted(name) {
      return deleted.has(name);
    },
  };
  return { keys, live, deleted };
}

const CLEAN: ClientReadBack = { tokensDeleted: true, installationsDeleted: true };

describe('runWithCaptureCleanup', () => {
  test('creates both keys, runs the body, then deletes both and reads them back', async () => {
    const fake = fakeKeys();
    const seen: string[] = [];
    const run = await runWithCaptureCleanup(fake.keys, RUN, async (created) => {
      seen.push(created['referrer-blocked'].keyString, created['installations-only'].keyString);
      return 'done';
    }, { client: async () => CLEAN });
    expect(run.result).toBe('done');
    expect(seen).toEqual(['secret-referrer-blocked', 'secret-installations-only']);
    expect(run.invariants).toEqual({ tokensDeleted: true, installationsDeleted: true, keysDeleted: true });
    expect(run.keys).toEqual({ before: 0, created: 2, after: 0 });
    expect(fake.live.size).toBe(0);
  });

  test('refuses before creating anything when a key already carries the run id', async () => {
    const fake = fakeKeys({ preexisting: true });
    await expect(runWithCaptureCleanup(fake.keys, RUN, async () => 'never', { client: async () => CLEAN })).rejects.toThrow(/already carry run id/);
    expect(fake.live.size).toBe(1);
  });

  test('keeps the body error and still cleans up when the body throws', async () => {
    const fake = fakeKeys();
    let cleaned = 0;
    const run = await runWithCaptureCleanup(fake.keys, RUN, async () => { throw new Error('delivery timed out'); }, {
      client: async () => { cleaned++; return CLEAN; },
    });
    expect(run.error?.message).toBe('delivery timed out');
    expect(cleaned).toBe(1);
    expect(run.invariants.keysDeleted).toBe(true);
    expect(fake.live.size).toBe(0);
  });

  test('deletes a key the list shows under the run id even when its create threw', async () => {
    const fake = fakeKeys({ failCreate: true });
    const run = await runWithCaptureCleanup(fake.keys, RUN, async () => 'never', { client: async () => CLEAN });
    expect(run.error?.message).toContain('timed out');
    expect(run.invariants.keysDeleted).toBe(true);
    expect(fake.live.size).toBe(0);
    expect(fake.deleted.size).toBe(2);
  });

  test('a failed key delete still deletes the other key and fails the invariant', async () => {
    const fake = fakeKeys({ failRemove: 'referrer-blocked' });
    const logs: string[] = [];
    const run = await runWithCaptureCleanup(fake.keys, RUN, async () => 'done', { client: async () => CLEAN, log: (m) => logs.push(m) });
    expect(run.invariants).toEqual({ tokensDeleted: true, installationsDeleted: true, keysDeleted: false });
    expect(run.keys.after).toBe(1);
    expect([...fake.deleted]).toEqual([`keys/${keyId(RUN, 'installations-only')}`]);
    expect(logs.join('\n')).toContain(`--cleanup ${RUN}`);
  });

  test('a client cleanup that throws fails its invariants and the keys are still deleted', async () => {
    const fake = fakeKeys();
    const run = await runWithCaptureCleanup(fake.keys, RUN, async () => 'done', { client: async () => { throw new Error('page closed'); } });
    expect(run.invariants).toEqual({ tokensDeleted: false, installationsDeleted: false, keysDeleted: true });
    expect(fake.live.size).toBe(0);
  });

  test('a client read-back that did not hold is reported as it came', async () => {
    const fake = fakeKeys();
    const run = await runWithCaptureCleanup(fake.keys, RUN, async () => 'done', { client: async () => ({ tokensDeleted: false, installationsDeleted: true }) });
    expect(run.invariants).toEqual({ tokensDeleted: false, installationsDeleted: true, keysDeleted: true });
  });
});

describe('redaction', () => {
  const token = `cAbCdEfGhIjKlMnOpQrStU:APA91b${'x'.repeat(140)}`;
  const fid = 'cAbCdEfGhIjKlMnOpQrStU';
  const raw = {
    op: 'getToken',
    method: 'POST',
    url: 'https://fcmregistrations.googleapis.com/v1/projects/demo-project/registrations',
    requestHeaders: { 'Content-Type': 'application/json', 'x-goog-api-key': 'never-recorded' },
    requestBody: JSON.stringify({ web: { endpoint: 'https://fcm.googleapis.com/fcm/send/abcdefghijkl:mnop', auth: 'pushAuthSecret0123', p256dh: 'BPushP256dhPublicKey0123456789' } }),
    status: 200,
    responseBody: JSON.stringify({ name: `projects/demo-project/registrations/${token}`, token }),
    responseHeaders: { 'content-type': 'application/json; charset=UTF-8', date: 'Thu, 05 Nov 2026 00:00:00 GMT' },
  };

  test('an exchange keeps header names, body keys and the headers the SDK reads', () => {
    const exchange = recordExchange(raw);
    expect(exchange).toMatchObject({
      api: 'registrations',
      action: 'create',
      path: '/v1/projects/demo-project/registrations',
      requestHeaderNames: ['content-type', 'x-goog-api-key'],
      requestContentType: 'application/json',
      requestBodyKeys: ['web', 'web.auth', 'web.endpoint', 'web.p256dh'],
      responseHeaderNames: ['content-type', 'date'],
      responseHeaders: { 'content-type': 'application/json; charset=UTF-8' },
    });
    expect(JSON.stringify(exchange)).not.toContain('never-recorded');
  });

  test('collected secrets become numbered placeholders, the FID inside the token too', () => {
    const redactor = new Redactor();
    redactor.add('demo-project', '<project>');
    new SecretCollector(redactor).exchange(raw);
    const text = redactor.apply(JSON.stringify(recordExchange(raw)));
    expect(text).toContain('registrations/<fcm-token-1>');
    expect(text).not.toContain(fid);
    expect(text).not.toContain('APA91b');
    expect(text).toContain('"host":"fcmregistrations.googleapis.com"');
  });

  test('the writer refuses while a registration token or push endpoint is left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-m-'));
    const path = join(dir, 'out.json');
    expect(() => writeMessagingRecording(path, { token }, new Redactor())).toThrow(/FCM registration token/);
    expect(() => writeMessagingRecording(path, { endpoint: 'https://fcm.googleapis.com/fcm/send/abcdefghijkl:mnop' }, new Redactor())).toThrow(/push endpoint/);
    expect(existsSync(path)).toBe(false);
    writeMessagingRecording(path, { token: '<fcm-token-1>' }, new Redactor());
    expect(existsSync(path)).toBe(true);
  });

  test('the console and the run-id file carry the real run id while the recording reads <run>', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-m-'));
    const redactor = new Redactor();
    redactor.add(RUN, '<run>');
    const printed: string[] = [];
    const file = join(dir, 'run-ids.log');
    announceRunId(RUN, { write: (line) => printed.push(line), file });
    expect(printed).toEqual([`[capture-m] run ${RUN}; if it stops partway, run the cleanup with --cleanup ${RUN}`]);
    expect(readFileSync(file, 'utf8')).toContain(`--cleanup ${RUN}`);
    announceRunId(RUN, { write: () => {}, file });
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);

    const path = join(dir, 'recordings', 'nested', 'out.json');
    writeMessagingRecording(path, { runId: RUN, apiKeys: { displayName: `pyric capture m ${RUN} referrer-blocked` } }, redactor);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(RUN);
    expect(text).toContain('"runId": "<run>"');
    expect(text).toContain('pyric capture m <run> referrer-blocked');
  });

  test('a push payload keeps its key set and only the values the run sent', () => {
    const shape = payloadShape(
      { from: '123456', priority: 'normal', fcmMessageId: 'abc', data: { tag: 'foreground', other: 'x' }, notification: { title: 'oracle foreground' } },
      new Set(['foreground', 'oracle foreground']),
    );
    expect(shape).toEqual({
      data: { other: '<string>', tag: 'foreground' },
      fcmMessageId: '<string>',
      from: '<string>',
      notification: { title: 'oracle foreground' },
      priority: 'normal',
    });
  });
});
