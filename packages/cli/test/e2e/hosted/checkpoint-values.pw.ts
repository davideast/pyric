import { once } from 'node:events';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test, type Page } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

async function readValues(page: Page) {
  return page.evaluate(async () => {
    const { doc, getDoc, getFirestore } = await import('firebase/firestore');
    const data = (await getDoc(doc(getFirestore(), 'shared/special'))).data();
    const isMissing = data === undefined;
    if (isMissing) throw new Error('Expected the saved document');
    return { timestamp: data.timestamp.toMillis(), bytes: Array.from(data.bytes.toUint8Array()),
      point: [data.point.latitude, data.point.longitude], reference: data.reference.path,
      nested: data.nested[0].toMillis() };
  });
}

test('Firestore special values retain their SDK behavior through checkpoint restore and host restart', async ({ page }) => {
  const fixture = await startHostedFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.evaluate(async () => {
      const { Bytes, GeoPoint, Timestamp, doc, getFirestore, setDoc } = await import('firebase/firestore');
      const db = getFirestore();
      await setDoc(doc(db, 'shared/special'), { timestamp: Timestamp.fromMillis(1700000000123),
        bytes: Bytes.fromUint8Array(Uint8Array.of(0, 128, 255)), point: new GeoPoint(37.42, -122.08),
        reference: doc(db, 'shared/target'), nested: [Timestamp.fromMillis(1600000000000)] });
    });
    const expected = { timestamp: 1700000000123, bytes: [0, 128, 255], point: [37.42, -122.08],
      reference: 'shared/target', nested: 1600000000000 };
    expect(await readValues(page)).toEqual(expected);
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.channel.op({ method: 'checkpoint', name: 'values' });
      await page.evaluate(async () => {
        const { doc, getFirestore, setDoc } = await import('firebase/firestore');
        await setDoc(doc(getFirestore(), 'shared/special'), { changed: true });
      });
      await control.channel.op({ method: 'restore', name: 'values' });
      expect(await readValues(page)).toEqual(expected);
    } finally {
      control.close();
    }
    await page.goto('about:blank');
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      expect(await readValues(page)).toEqual(expected);
    } finally {
      await replacement.stop();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});

test('checkpoint restore and restart keep an ordinary map whose fields resemble a timestamp marker', async ({ page }) => {
  const fixture = await startHostedFixture();
  const literal = { __type: 'timestamp', seconds: 5, nanos: 0, note: 'ordinary map' };
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.evaluate(async literal => {
      const { doc, getFirestore, setDoc } = await import('firebase/firestore');
      await setDoc(doc(getFirestore(), 'shared/literal'), { literal });
    }, literal);
    const readLiteral = () => page.evaluate(async () => {
      const { doc, getDoc, getFirestore } = await import('firebase/firestore');
      return (await getDoc(doc(getFirestore(), 'shared/literal'))).data()?.literal;
    });
    expect(await readLiteral()).toEqual(literal);
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.channel.op({ method: 'checkpoint', name: 'literal' });
      await control.channel.op({ method: 'restore', name: 'literal' });
      expect(await readLiteral()).toEqual(literal);
    } finally {
      control.close();
    }
    await page.goto('about:blank');
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      expect(await readLiteral()).toEqual(literal);
    } finally {
      await replacement.stop();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});
