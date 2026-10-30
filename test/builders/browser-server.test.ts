import { describe, expect, test } from 'bun:test';
import { chromiumArgs, HOST_RESOLVER_RULES } from './browser-server.ts';

describe('chromiumArgs', () => {
  test('writes the NetLog where asked and resolves only loopback', () => {
    expect(chromiumArgs('/run/x/chromium-netlog.json')).toEqual([
      '--log-net-log=/run/x/chromium-netlog.json',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    ]);
  });

  test('maps every host to not-found and excludes nothing but localhost and 127.0.0.1', () => {
    const rules = HOST_RESOLVER_RULES.split(',').map((rule) => rule.trim());
    expect(rules[0]).toBe('MAP * ~NOTFOUND');
    expect(rules.slice(1)).toEqual(['EXCLUDE localhost', 'EXCLUDE 127.0.0.1']);
  });
});
