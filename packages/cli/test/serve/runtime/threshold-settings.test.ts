import { expect, test } from 'bun:test';
import { createThresholdSettings } from '../../../src/serve/runtime/threshold-settings.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test('session edits are drafts, Cancel discards them, Save changes effective settings, and defaults remain implicit', async () => {
  const settings = createThresholdSettings(undefined, () => {});
  await settings.load(); settings.open('rtdb'); await tick();
  settings.edit('writes', '3'); expect(settings.config()).toEqual({});
  settings.cancel(); expect(settings.config()).toEqual({});
  settings.open('rtdb'); await tick(); settings.edit('writes', '3'); await settings.save();
  expect(settings.config()).toEqual({ rtdb: { writes: 3 } });
  settings.open('rtdb'); await tick(); settings.defaults(); await settings.save();
  expect(settings.config()).toEqual({});
  settings.dispose();
});
test('failed project saves retain the draft and do not change active limits', async () => {
  const settings = createThresholdSettings({ read: async () => ({ config: {}, revision: 'a' }), save: async () => { throw new Error('pyric.json changed'); } }, () => {});
  await settings.load(); settings.open('rtdb'); await tick(); settings.edit('writes', '3'); await settings.save();
  expect(settings.config()).toEqual({});
  expect(settings.state()).toMatchObject({ error: 'pyric.json changed', draft: { rtdb: { writes: 3 } }, service: 'rtdb' });
  settings.dispose();
});

test('invalid durations block Save without converting an empty duration into a default', async () => {
  const settings = createThresholdSettings(undefined, () => {});
  await settings.load(); settings.open('rtdb'); await tick();
  settings.edit('sustainedSeconds', ''); await settings.save();
  expect(settings.state().invalid).toBe(true);
  expect(settings.config()).toEqual({});
  settings.edit('sustainedSeconds', '2'); await settings.save();
  expect(settings.config().sustainedSeconds).toBe(2);
  settings.dispose();
});
