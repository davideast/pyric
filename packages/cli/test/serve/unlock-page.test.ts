import { afterEach, describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderUnlockHtml } from '../../src/serve/unlock-page.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function mountUnlockDom(options: {
  nextPath?: string;
  url?: string;
  secureContext?: boolean;
  fetchImpl?: (input: unknown, init?: RequestInit) => Promise<Response>;
}): JSDOM {
  const html = renderUnlockHtml(options.nextPath ?? '/');
  const dom = new JSDOM(html, {
    url: options.url ?? 'https://devbox.example.com/__pyric/unlock',
  });
  cleanups.push(() => dom.window.close());
  if (options.secureContext !== undefined) {
    Object.defineProperty(dom.window, 'isSecureContext', {
      value: options.secureContext,
      configurable: true,
    });
  }
  const scriptText = dom.window.document.querySelector('script')?.textContent ?? '';
  const fetchFn = options.fetchImpl ?? (async () => new Response('{}', { status: 200 }));
  const runInline = new Function(
    'window',
    'document',
    'location',
    'history',
    'fetch',
    'URLSearchParams',
    'FontFace',
    'atob',
    scriptText,
  );
  runInline(
    dom.window,
    dom.window.document,
    dom.window.location,
    dom.window.history,
    fetchFn,
    dom.window.URLSearchParams,
    undefined,
    dom.window.atob.bind(dom.window),
  );
  return dom;
}

describe('renderUnlockHtml', () => {
  it('reuses Pyric runtime panel tokens, components, embedded fonts, and overflow-safe wrapping', () => {
    const html = renderUnlockHtml('/app/room?tab=traffic');

    // Uses Pyric runtime panel design tokens and embedded Geist font families.
    expect(html).toContain('--pyric-bg: #1b1d23;');
    expect(html).toContain('--pyric-content: #15171c;');
    expect(html).toContain('--pyric-border: #3a3e49;');
    expect(html).toContain('Pyric Geist');
    expect(html).toContain('Pyric Geist Mono');

    // Does not fall back to unstyled system CSS colors or external network assets.
    expect(html).not.toContain('background: Canvas');
    expect(html).not.toContain('background: Highlight');
    expect(html).not.toMatch(/https?:\/\//i);

    // Reuses shared Pyric runtime panel components and overflow-safe wrapping rules.
    expect(html).toContain('class="panel unlock-panel"');
    expect(html).toContain('class="panel-header unlock-header"');
    expect(html).toContain('class="panel-name">pyric<');
    expect(html).toContain('class="verdict bypassed"');
    expect(html).toContain('class="sandbox-ai-facts unlock-facts"');
    expect(html).toContain('class="field unlock-field"');
    expect(html).toContain('class="btn btn-primary unlock-submit"');
    expect(html).toContain('data-action-bar');
    expect(html).toContain('overflow-wrap: anywhere');
    expect(html).toContain('word-break: break-word');
  });

  it('escapes HTML and inline script characters in the redirect path', () => {
    const html = renderUnlockHtml('/app?a=1&b=</script><img src=x>');
    expect(html).not.toContain('</script><img');
    expect(html).toContain('&lt;/script&gt;&lt;img');
    expect(html).toContain('\\u003c/script\\u003e\\u003cimg');
  });

  it('populates host/redirect, toggles token visibility, and shows plain-HTTP warning only when insecure', () => {
    const longHost = 'b2607f8b04800100000b20f5eac120f83143e000000000000000001.proxy.example.com';
    const secureDom = mountUnlockDom({
      nextPath: '/studio/firestore',
      url: `https://${longHost}/__pyric/unlock?next=%2Fstudio%2Ffirestore`,
      secureContext: true,
    });
    const doc = secureDom.window.document;
    expect(doc.getElementById('host')?.textContent).toBe(longHost);
    expect(doc.getElementById('dest')?.textContent).toBe('/studio/firestore');
    expect(doc.getElementById('http-warn')?.hidden).toBe(true);

    const tokenInput = doc.getElementById('token') as HTMLInputElement;
    const toggleBtn = doc.getElementById('toggle-token') as HTMLButtonElement;
    expect(tokenInput.type).toBe('password');
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');

    toggleBtn.click();
    expect(tokenInput.type).toBe('text');
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
    expect(toggleBtn.getAttribute('aria-label')).toBe('Hide token');

    toggleBtn.click();
    expect(tokenInput.type).toBe('password');
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');

    const insecureDom = mountUnlockDom({
      nextPath: '/',
      url: 'http://devbox.example.com:5173/__pyric/unlock',
      secureContext: false,
    });
    expect(insecureDom.window.document.getElementById('http-warn')?.hidden).toBe(false);
  });

  it('updates verdict, status tone, and aria-invalid on failed unlock and strips #code fragments', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const dom = mountUnlockDom({
      nextPath: '/app',
      url: 'https://devbox.example.com/__pyric/unlock?next=%2Fapp#code=fragment-secret',
      secureContext: true,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body ?? '') });
        return new Response(
          JSON.stringify({ error: 'invalid_token', message: 'Invalid session capability token.' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    // Fragment token is scrubbed synchronously from the address bar and submitted.
    expect(dom.window.location.hash).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ token: 'fragment-secret', next: '/app' });

    const doc = dom.window.document;
    const status = doc.getElementById('status');
    const verdict = doc.getElementById('session-verdict');
    const tokenInput = doc.getElementById('token') as HTMLInputElement;
    expect(status?.hidden).toBe(false);
    expect(status?.getAttribute('data-tone')).toBe('error');
    expect(status?.textContent).toBe('Invalid session capability token.');
    expect(verdict?.querySelector('.verdict-label')?.textContent).toBe('Failed');
    expect(tokenInput.getAttribute('aria-invalid')).toBe('true');

    tokenInput.dispatchEvent(new dom.window.Event('input'));
    expect(tokenInput.getAttribute('aria-invalid')).toBeNull();
  });
});
