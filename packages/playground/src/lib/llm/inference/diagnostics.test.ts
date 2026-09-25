import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  REDACTED,
  redactDiagnosticString,
  sanitizeHeaders,
  sanitizeDiagnosticMeta,
  logPage,
  exportLogs,
  restoreLogs,
  clearPageLog,
} from './diagnostics';

describe('diagnostics — redaction and local storage sanitization', () => {
  const originalWindow = (globalThis as any).window;

  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    };
    clearPageLog();
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  });

  test('redactDiagnosticString scrubs Bearer tokens and API keys', () => {
    expect(redactDiagnosticString('Bearer sk-or-v1-secret1234567890abcdef')).toBe(
      `Bearer ${REDACTED}`,
    );
    expect(redactDiagnosticString('key=sk-proj-abcdef1234567890abcdef1234')).toBe(
      `key=${REDACTED}`,
    );
    expect(redactDiagnosticString('AIzaSyA12345678901234567890123456789012')).toBe(REDACTED);
  });

  test('sanitizeHeaders redacts sensitive headers across object, Headers, and tuple formats', () => {
    const sanitizedObj = sanitizeHeaders({
      Authorization: 'Bearer secret-token',
      'X-Api-Key': 'my-secret-key',
      'Content-Type': 'application/json',
    });
    expect(sanitizedObj.Authorization).toBe(REDACTED);
    expect(sanitizedObj['X-Api-Key']).toBe(REDACTED);
    expect(sanitizedObj['Content-Type']).toBe('application/json');

    const sanitizedTuples = sanitizeHeaders([
      ['authorization', 'Bearer abc'],
      ['accept', 'text/event-stream'],
    ]);
    expect(sanitizedTuples.authorization).toBe(REDACTED);
    expect(sanitizedTuples.accept).toBe('text/event-stream');
  });

  test('sanitizeDiagnosticMeta redacts nested sensitive fields while preserving safe fields', () => {
    const meta = sanitizeDiagnosticMeta({
      model: 'openai/gpt-5.5',
      stream: true,
      apiKey: 'sk-or-v1-1234567890abcdef123456',
      headers: {
        Authorization: 'Bearer super-secret-jwt',
        'X-Custom': 'safe-value',
      },
      nested: {
        access_token: 'tok_123',
        note: 'Called with Bearer inline_secret_token_xyz',
      },
    });

    expect(meta.model).toBe('openai/gpt-5.5');
    expect(meta.stream).toBe(true);
    expect(meta.apiKey).toBe(REDACTED);
    expect((meta.headers as Record<string, unknown>).Authorization).toBe(REDACTED);
    expect((meta.headers as Record<string, unknown>)['X-Custom']).toBe('safe-value');
    expect((meta.nested as Record<string, unknown>).access_token).toBe(REDACTED);
    expect((meta.nested as Record<string, unknown>).note).toBe(`Called with Bearer ${REDACTED}`);
  });

  test('logPage and restoreLogs never persist plaintext API keys or Authorization headers to localStorage', async () => {
    logPage('openrouter_wire_request', 'req_1', {
      model: 'anthropic/claude-3.7-sonnet',
      headers: {
        Authorization: 'Bearer sk-or-v1-plaintext-secret-token',
      },
      apiKey: 'sk-or-v1-plaintext-secret-token',
    });

    const exported = await exportLogs();
    expect(exported.page).toHaveLength(1);
    const storedMeta = exported.page[0]!.meta!;
    expect(storedMeta.apiKey).toBe(REDACTED);
    expect((storedMeta.headers as Record<string, unknown>).Authorization).toBe(REDACTED);

    const rawStorage = (globalThis as any).window.localStorage.getItem('pyric.diagnostics.log');
    expect(rawStorage).not.toContain('plaintext-secret-token');

    // Also verify restoreLogs sanitizes incoming payloads before persisting
    await restoreLogs({
      exportedAt: Date.now(),
      userAgent: 'test',
      inferenceMode: 'direct',
      visibility: 'visible',
      online: true,
      connectionType: null,
      counts: { page: 1 },
      page: [
        {
          ts: Date.now(),
          event: 'restored_event',
          meta: {
            authorization: 'Bearer restored-secret-jwt',
          },
        },
      ],
    });

    const rawAfterRestore = (globalThis as any).window.localStorage.getItem(
      'pyric.diagnostics.log',
    );
    expect(rawAfterRestore).not.toContain('restored-secret-jwt');
    expect(rawAfterRestore).toContain(REDACTED);
  });
});
