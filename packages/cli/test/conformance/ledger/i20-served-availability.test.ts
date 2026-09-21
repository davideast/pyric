import { expect, test } from 'bun:test';
import { canIUse } from '../../../src/conformance/can-i-use.js';
import { canIUse as browserCanIUse } from '../../../src/conformance/browser.js';
import { createConformanceTools } from '../../../src/conformance/tools.js';
import { CONFORMANCE_SUPPORTS } from '../../../src/conformance/.generated/can-i-use.js';
import { SERVED_MODULES } from '../../../src/conformance/.generated/served-availability.js';
import { classifyServedExport } from '../../../src/conformance/served-query.js';
import { deriveServedModules, servedServices } from '../../../scripts/generate-served-availability.ts';

test('served availability is generated from all seven real entry exports and their refusal modules', async () => {
  expect(servedServices).toEqual(['app', 'auth', 'firestore', 'database', 'storage', 'messaging', 'ai']);
  expect(SERVED_MODULES).toEqual(await deriveServedModules());
  for (const module of Object.values(SERVED_MODULES)) {
    for (const feature of module.expected) expect(classifyServedExport(module, feature)).not.toBe('missing');
    for (const feature of module.importsOnly) expect(module.exports).toContain(feature);
  }
});

test('runtime classifications have a reviewable snapshot', () => {
  const classifications = Object.fromEntries(Object.entries(SERVED_MODULES).map(([service, module]) => {
    const names = [...new Set([...module.expected, ...module.exports])].sort();
    const statuses = Object.fromEntries(names.map(name => [name, classifyServedExport(module, name)]));
    return [service, statuses];
  }));
  expect(classifications).toMatchSnapshot();
});

test('a missing export cannot borrow support from an unused refusal declaration', () => {
  const module = { surface: 'auth', expected: ['linkWithPopup'], exports: [], importsOnly: ['linkWithPopup'] };
  expect(classifyServedExport(module, 'linkWithPopup')).toBe('missing');
  const exported = { ...module, exports: ['linkWithPopup'] };
  expect(classifyServedExport(exported, 'linkWithPopup')).toBe('imports-only');
  expect(classifyServedExport({ ...exported, importsOnly: [] }, 'linkWithPopup')).toBe('supported');
});

test('the agent query reports linkWithPopup as supported with and without firebase/auth', async () => {
  const tool = createConformanceTools().find(tool => tool.name === 'pyric_can_i_use');
  const missingTool = tool === undefined;
  if (missingTool) throw new Error('Missing conformance tool');
  for (const args of [{ feature: 'linkWithPopup' }, { feature: 'linkWithPopup', importPath: 'firebase/auth' }]) {
    const response = await tool.execute(args);
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({ match: 'exact', supports: [{
      feature: 'linkWithPopup', surface: 'auth', served: 'supported',
    }] });
  }
});

test('engine support does not conceal an imports-only served function', () => {
  const result = canIUse('validatePassword', { importPath: 'firebase/auth' });
  expect(result).toMatchObject({ match: 'exact', supports: [{ availability: 'available', served: 'imports-only' }] });
  expect(result.supports[0]?.caveats).toEqual(expect.arrayContaining([expect.stringMatching(/served.*throws/i)]));
  expect(result.supports[0]?.summary).toMatch(/imports-only/i);
});

test('existing unconditional worker refusals are imports-only too', () => {
  expect(canIUse('beforeAuthStateChanged', { importPath: 'firebase/auth' })).toMatchObject({
    match: 'exact', supports: [{ served: 'imports-only' }],
  });
  expect(canIUse('updateMetadata', { importPath: 'firebase/storage' })).toMatchObject({
    match: 'exact', supports: [{ served: 'imports-only' }],
  });
});

const imports = [
  ['app', 'initializeApp'], ['auth', 'getAuth'], ['firestore', 'getDoc'], ['database', 'ref'],
  ['storage', 'uploadBytes'], ['messaging', 'getToken'], ['ai', 'getGenerativeModel'],
] as const;

test('all seven Firebase runtime imports resolve to their served entry', () => {
  for (const [service, feature] of imports) {
    expect(canIUse(feature, { importPath: `firebase/${service}` })).toMatchObject({
      match: 'exact', supports: [{ feature, served: 'supported' }],
    });
  }
  expect(canIUse('linkWithPopup', { importPath: 'firebase/storage' }).match).toBe('none');
  expect(canIUse('linkWithPopup', { importPath: 'firebase/unknown' }).match).toBe('none');
});

test('served reporting preserves engine trust axes and agrees across Node and browser queries', () => {
  for (const feature of ['linkWithPopup', 'validatePassword', 'updateMetadata']) {
    const node = canIUse(feature);
    const browser = browserCanIUse(feature);
    expect(node.supports.length).toBeGreaterThan(0);
    expect({ ...node, supports: node.supports.map(({ claims, ...support }) => support) }).toEqual(browser);
    for (const support of node.supports) {
      const original = CONFORMANCE_SUPPORTS.find(entry => entry.feature === support.feature && entry.surface === support.surface);
      expect(support).toMatchObject({ availability: original?.availability, fidelity: original?.fidelity,
        assurance: original?.assurance, claims: original?.claims, importPaths: original?.importPaths });
    }
  }
});

test('erased type features keep their engine evidence without a runtime availability claim', () => {
  const result = canIUse('ActionCodeSettings', { importPath: 'firebase/auth' });
  expect(result).toMatchObject({ match: 'exact', supports: [{ feature: 'ActionCodeSettings' }] });
  expect(result.supports[0]).not.toHaveProperty('served');
});
