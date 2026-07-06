/**
 * Tests for the Ollama SSRF guard (#766). Pure IP-literal checks need no
 * network; hostname resolution is exercised with a stubbed resolver.
 */
import { describe, test, expect } from 'bun:test';
import {
  assertSafeServerBaseUrl,
  classifyAddress,
  SsrfBlockedError,
  type HostResolver,
} from './ollama-ssrf';

describe('classifyAddress', () => {
  test('blocks GCP metadata IP + hostname', () => {
    expect(classifyAddress('169.254.169.254').blocked).toBe(true);
    expect(classifyAddress('metadata.google.internal').blocked).toBe(true);
    expect(classifyAddress('metadata').blocked).toBe(true);
  });

  test('blocks loopback / RFC1918 / link-local', () => {
    expect(classifyAddress('127.0.0.1').blocked).toBe(true);
    expect(classifyAddress('10.1.2.3').blocked).toBe(true);
    expect(classifyAddress('172.16.5.5').blocked).toBe(true);
    expect(classifyAddress('192.168.0.1').blocked).toBe(true);
    expect(classifyAddress('169.254.1.1').blocked).toBe(true);
    expect(classifyAddress('::1').blocked).toBe(true);
    expect(classifyAddress('fe80::1').blocked).toBe(true);
    expect(classifyAddress('fd00::1').blocked).toBe(true);
    expect(classifyAddress('::ffff:127.0.0.1').blocked).toBe(true);
  });

  test('allows public addresses', () => {
    expect(classifyAddress('93.184.216.34').blocked).toBe(false); // example.com
    expect(classifyAddress('8.8.8.8').blocked).toBe(false);
  });
});

describe('assertSafeServerBaseUrl', () => {
  test('rejects the GCP metadata endpoint', async () => {
    await expect(assertSafeServerBaseUrl('http://169.254.169.254')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  test('rejects loopback', async () => {
    await expect(assertSafeServerBaseUrl('http://127.0.0.1:11434')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  test('rejects a non-http(s) scheme', async () => {
    await expect(assertSafeServerBaseUrl('file:///etc/passwd')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(assertSafeServerBaseUrl('gopher://127.0.0.1')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  test('allows a normal https host (public IP literal, no DNS)', async () => {
    await expect(assertSafeServerBaseUrl('https://93.184.216.34/v1')).resolves.toBeUndefined();
  });

  test('resolves a hostname and rejects when it points at an internal IP', async () => {
    const evilResolver: HostResolver = async () => ['169.254.169.254'];
    await expect(
      assertSafeServerBaseUrl('https://attacker.example.com', evilResolver),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test('allows a hostname that resolves to a public IP', async () => {
    const goodResolver: HostResolver = async () => ['93.184.216.34'];
    await expect(
      assertSafeServerBaseUrl('https://ollama.example.com', goodResolver),
    ).resolves.toBeUndefined();
  });
});
