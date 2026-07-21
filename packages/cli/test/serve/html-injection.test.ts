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
    const out = injectServeTags('<html><head></head></html>', undefined, 'abc123');
    expect(out).toContain('<meta name="pyric-worker-v" content="abc123"');
    expect(out.indexOf('pyric-worker-v')).toBeLessThan(out.indexOf('importmap'));
    expect(injectServeTags('<html><head></head></html>')).not.toContain('pyric-worker-v');
  });

  it('forces the in-page sandbox before init when requested', () => {
    const out = injectServeTags('<html><head></head></html>', undefined, undefined, true);
    expect(out).toContain('__PYRIC_FORCE_INPAGE__=true');
    expect(out.indexOf('__PYRIC_FORCE_INPAGE__')).toBeLessThan(out.indexOf('/__pyric/sdk/init.js'));
    expect(injectServeTags('<html><head></head></html>')).not.toContain('__PYRIC_FORCE_INPAGE__');
  });

  it('leaves a marked sandbox build in charge of booting its runtime', () => {
    const marked =
      '<html><head><meta name="pyric-sandbox-build" content="1" data-pyric-sandbox-build></head><body></body></html>';
    const out = injectServeTags(marked, undefined, 'abc123');
    expect(out).not.toContain('importmap');
    expect(out).not.toContain('/__pyric/sdk/init.js');
    expect(out).toContain('<meta name="pyric-worker-v" content="abc123"');
    expect(injectServeTags(out, undefined, 'abc123')).toBe(out);
    expect(injectServeTags(marked)).toBe(marked);
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
