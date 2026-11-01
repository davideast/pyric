import { describe, expect, test } from 'bun:test';
import { hostInHeadStart, namedHost, parseHead, shownRequestLine, type RequestHead } from './http-head.ts';
import { forwardedHeaders, requestRefusal } from './model-policy.ts';

function head(text: string): RequestHead {
  const parsed = parseHead(text);
  if (parsed === undefined) throw new Error(`unparsed: ${text}`);
  return parsed;
}

describe('parseHead', () => {
  test('reads the request line and lowercases field names, keeping repeats', () => {
    expect(parseHead('POST /v1/messages HTTP/1.1\r\nHost: a\r\nAnthropic-Beta: x\r\nanthropic-beta: y')).toEqual({
      method: 'POST', target: '/v1/messages', headers: [['host', 'a'], ['anthropic-beta', 'x'], ['anthropic-beta', 'y']],
    });
  });

  test('reads nothing it would have to guess at', () => {
    for (const text of ['POST /v1/messages', 'post / HTTP/1.1', 'POST / HTTP/2', 'POST / HTTP/1.1\r\nno colon', 'POST / HTTP/1.1\r\nBad Name: x', 'POST / HTTP/1.1\r\nx: a\u0000b']) {
      expect(parseHead(text)).toBeUndefined();
    }
  });

  test('shows a request line short and printable', () => {
    expect(shownRequestLine('GET /\u0001\r\nrest')).toBe('GET /\\x01');
    expect(shownRequestLine(`GET /${'a'.repeat(400)}`)).toHaveLength(301);
  });
});

describe('namedHost', () => {
  test('takes a CONNECT authority, an absolute URI’s host, or the Host field', () => {
    expect(namedHost(head('CONNECT oauth2.googleapis.com:443 HTTP/1.1'))).toBe('oauth2.googleapis.com');
    expect(namedHost(head('CONNECT [2001:db8::1]:443 HTTP/1.1'))).toBe('2001:db8::1');
    expect(namedHost(head('GET http://169.254.169.254/latest HTTP/1.1\r\nHost: elsewhere'))).toBe('169.254.169.254');
    expect(namedHost(head('GET / HTTP/1.1\r\nHost: Firestore.GoogleAPIs.com:443'))).toBe('firestore.googleapis.com');
    expect(namedHost(head('GET / HTTP/1.1'))).toBeUndefined();
  });

  test('reads the host from the start of a head it could not read whole', () => {
    expect(hostInHeadStart('CONNECT metadata.google.internal:80 HTTP/1.1\r\nbroken')).toBe('metadata.google.internal');
    expect(hostInHeadStart('GET http://oauth2.googleapis.com/ HT')).toBe('oauth2.googleapis.com');
    expect(hostInHeadStart('GET / HTTP/1.1\r\nHost: x\r\nbroken')).toBeUndefined();
    expect(hostInHeadStart('')).toBeUndefined();
  });
});

describe('requestRefusal', () => {
  test('lets through only POSTs to the Messages paths claude needs', () => {
    for (const target of ['/v1/messages', '/v1/messages?beta=true', '/v1/messages/count_tokens', '/v1/messages/count_tokens?beta=true']) {
      expect(requestRefusal(head(`POST ${target} HTTP/1.1`))).toBeUndefined();
    }
  });

  test('refuses everything else, naming why', () => {
    expect(requestRefusal(head('CONNECT api.anthropic.com:443 HTTP/1.1'))).toBe('connect');
    expect(requestRefusal(head('POST https://api.anthropic.com/v1/messages HTTP/1.1'))).toBe('absolute-uri');
    expect(requestRefusal(head('GET /v1/models?limit=1000 HTTP/1.1'))).toBe('method');
    expect(requestRefusal(head('HEAD /api/hello HTTP/1.1'))).toBe('method');
    for (const target of ['/v1/messages/batches', '/v1/messages/', '/v1//messages', '/v1/messages/../files', '/v1/messages?beta=false', '/v1/messages?beta=true&x', '/v1/messages#x', '*']) {
      expect(requestRefusal(head(`POST ${target} HTTP/1.1`))).toBe('path');
    }
  });
});

describe('forwardedHeaders', () => {
  test('drops the builder’s credentials and hop headers, sets the real credential, and keeps the API’s own headers as sent', () => {
    const sent = head([
      'POST /v1/messages HTTP/1.1', 'Host: 127.0.0.1:4000', 'Authorization: Bearer placeholder', 'X-Api-Key: k', 'Cookie: c',
      'Connection: keep-alive, X-Hop', 'X-Hop: 1', 'Accept-Encoding: gzip', 'Content-Length: 9',
      'anthropic-version: 2023-06-01', 'anthropic-beta: oauth-2025-04-20', 'anthropic-beta: other', 'user-agent: claude-cli',
    ].join('\r\n'));
    expect(forwardedHeaders(sent, 'real', 2)).toEqual({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20, other',
      'user-agent': 'claude-cli',
      host: 'api.anthropic.com',
      authorization: 'Bearer real',
      'content-length': '2',
      'accept-encoding': 'identity',
    });
  });
});
