// DF-1 (#1247): on the Node host, a page's runTransaction that makes a
// data-dependent `.read` false must cancel the listeners that rule guards, as
// a set does, and later data must never reach them. Covers a rule over `root`,
// a rule over the listener's own `data`, and a transaction with applyLocally
// false.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario } from '../driver.ts';

type Events = Record<'gate' | 'room' | 'roomNotLocal', string[]>;

declare const gate: {
  seed(): Promise<void>;
  listen(): void;
  close(): Promise<void>;
  writeAfter(): Promise<void>;
  events(): Events;
  markers(): unknown[];
};

const CANCELS = ['added cancel PERMISSION_DENIED', 'value cancel PERMISSION_DENIED'];
const ROOM_REVOKED = ['added a', 'added open', ...CANCELS, 'value'].sort();
const REVOKED: Events = {
  gate: ['added a', ...CANCELS, 'value'].sort(),
  room: ROOM_REVOKED,
  roomNotLocal: ROOM_REVOKED,
};

function sorted(events: Events): Events {
  return Object.fromEntries(Object.entries(events).map(([name, list]) => [name, [...list].sort()])) as Events;
}

/** The page's events, sorted, once they equal `expected` or 10 seconds have passed. */
async function settledEvents(page: Page, expected: Events): Promise<Events> {
  const deadline = Date.now() + 10_000;
  let events = sorted(await page.evaluate(() => gate.events()));
  while (JSON.stringify(events) !== JSON.stringify(expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    events = sorted(await page.evaluate(() => gate.events()));
  }
  return events;
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const page = await app.step('open the page, seed every target readable, and listen to each', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'gate' in window, undefined, { timeout: 30_000 });
    await page.evaluate(() => gate.seed());
    await page.evaluate(() => gate.listen());
    const roomOpen = ['added a', 'added open', 'value'];
    assert.deepEqual(await settledEvents(page, { gate: ['added a', 'value'], room: roomOpen, roomNotLocal: roomOpen }),
      { gate: ['added a', 'value'], room: roomOpen, roomNotLocal: roomOpen });
    return page;
  });

  await app.step('transactions that make each .read false cancel its listeners', async () => {
    await page.evaluate(() => gate.close());
    assert.deepEqual(await settledEvents(page, REVOKED), REVOKED);
  });

  await app.step('data written after the revocation never reaches the page', async () => {
    await page.evaluate(() => gate.writeAfter());
    await page.waitForFunction(() => gate.markers().includes(1), undefined, { timeout: 10_000 });
    assert.deepEqual(sorted(await page.evaluate(() => gate.events())), REVOKED);
  });
});
