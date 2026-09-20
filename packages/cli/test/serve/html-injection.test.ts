import { runInNewContext } from 'node:vm';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { stampHostedTarget } from '../../src/serve/runtime/hosted-target.js';
import { describe, expect, it } from 'bun:test';
import { injectServeTags, sdkImportMap } from '../../src/serve/html-injection.js';

describe('HTML sandbox injection', () => {
  it('places the import map and init script before application modules', () => {
    const out = injectServeTags(
      '<html><head><script type="module" src="/app.js"></script></head></html>',
    );
    expect(out.indexOf('type="importmap"')).toBeLessThan(out.indexOf('src="/app.js"'));
    expect(out.indexOf('/__pyric/sdk/init.js')).toBeLessThan(out.indexOf('src="/app.js"'));
    expect(out).toContain('"firebase/auth":"/__pyric/sdk/auth.js"');
    expect(injectServeTags(out)).toBe(out);
  });

  it('falls back when head is absent', () => {
    expect(injectServeTags('<html><body>x</body></html>')).toContain('importmap');
    expect(injectServeTags('no tags at all')).toContain('importmap');
  });

  it('stamps the worker version before the import map', () => {
    const out = injectServeTags('<html><head></head></html>', { workerVersion: 'abc123' });
    expect(out).toContain('<meta name="pyric-worker-v" content="abc123"');
    expect(out.indexOf('pyric-worker-v')).toBeLessThan(out.indexOf('importmap'));
    expect(injectServeTags('<html><head></head></html>')).not.toContain('pyric-worker-v');
  });

  it('forces the in-page sandbox before init when requested', () => {
    const out = injectServeTags('<html><head></head></html>', { forceInPage: true });
    expect(out).toContain('__PYRIC_FORCE_INPAGE__=true');
    expect(out.indexOf('__PYRIC_FORCE_INPAGE__')).toBeLessThan(out.indexOf('/__pyric/sdk/init.js'));
    expect(injectServeTags('<html><head></head></html>')).not.toContain('__PYRIC_FORCE_INPAGE__');
  });

  it('leaves a marked sandbox build in charge of booting its runtime', () => {
    const marked =
      '<html><head><meta name="pyric-sandbox-build" content="1" data-pyric-sandbox-build></head><body></body></html>';
    const out = injectServeTags(marked, { workerVersion: 'abc123' });
    expect(out).not.toContain('importmap');
    expect(out).not.toContain('/__pyric/sdk/init.js');
    expect(out).toContain('<meta name="pyric-worker-v" content="abc123"');
    expect(injectServeTags(out, { workerVersion: 'abc123' })).toBe(out);
    const bootstrapped = injectServeTags(marked);
    expect(bootstrapped).toContain('data-pyric-react-hook');
    expect(bootstrapped).not.toContain('/__pyric/sdk/init.js');
    expect(injectServeTags(bootstrapped)).toBe(bootstrapped);
  });

  it('maps every served Firebase module', () => {
    expect(Object.keys(sdkImportMap()).sort()).toEqual([
      'firebase/ai',
      'firebase/app',
      'firebase/auth',
      'firebase/database',
      'firebase/firestore',
      'firebase/messaging',
      'firebase/messaging/sw',
      'firebase/storage',
    ]);
  });
});

function inlinedSelection(html: string): unknown {
  const scripts = [...html.matchAll(/<script data-pyric-worker-init>(.*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const scope: { __PYRIC_WORKER_INIT__?: unknown } = {};
  runInNewContext(scripts[0]![1]!, scope);
  return scope.__PYRIC_WORKER_INIT__;
}

it('inlines transport selection before init and application scripts', () => {
  const html = injectServeTags('<head><script type="module" src="app.js"></script></head>');
  expect(inlinedSelection(html)).toEqual({ hosted: false, projectKey: null, bridgeUrl: null });
  expect(html.indexOf('data-pyric-worker-init')).toBeLessThan(html.indexOf('/__pyric/sdk/init.js'));
  expect(html.indexOf('data-pyric-worker-init')).toBeLessThan(html.indexOf('src="app.js"'));
});

it('escapes hosted identity in the inline script', () => {
  const projectKey = '</script><script>unexpected()</script>';
  const html = injectServeTags('<head></head>', { hosted: { projectKey } });
  expect(html).not.toContain(projectKey);
  expect(inlinedSelection(html)).toEqual({ hosted: true, projectKey, bridgeUrl: '/__pyric/sandbox' });
});

it('replaces a built page selection with the serving host selection exactly once', () => {
  const built = stampHostedTarget('<head><script type="module" src="app.js"></script></head>', undefined);
  const hosted = stampHostedTarget(built, 'orbit');
  expect(inlinedSelection(hosted)).toEqual({ hosted: true, projectKey: 'orbit', bridgeUrl: '/__pyric/sandbox' });
  const shared = stampHostedTarget(hosted, undefined);
  expect(inlinedSelection(shared)).toEqual({ hosted: false, projectKey: null, bridgeUrl: null });
  expect(shared).not.toContain('name="pyric-sandbox-host"');
});


it('inlines the same sandbox endpoint supplied by the bridge in init.json', async () => {
  const bridge = createBridgeMount();
  try {
    const html = injectServeTags('<head></head>', { hosted: { projectKey: 'orbit' } });
    const endpoint = new URL(bridge.wsUrl({ host: '127.0.0.1', port: 5217 }));
    expect(inlinedSelection(html)).toEqual({ hosted: true, projectKey: 'orbit', bridgeUrl: endpoint.pathname });
  } finally { await bridge.close(); }
});
