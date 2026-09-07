/** The page-level avatar upgrader: an `avatar-ready` frame reloads the
 *  images showing that uid's placeholder, and application code stays a plain
 *  `<img src={user.photoURL}>`. */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import {
  installAvatarUpgrades,
  type AvatarEventStream,
} from '../../../src/serve/entries/avatar-upgrade.js';

/** A stand-in for `EventSource`: records the URL it was opened with and lets
 *  a test deliver a frame without a connection. */
function fakeEventStream() {
  const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  const opened: string[] = [];
  const stream: AvatarEventStream = {
    addEventListener(type, listener) {
      const forType = listeners.get(type) ?? [];
      forType.push(listener);
      listeners.set(type, forType);
    },
  };
  return {
    opened,
    open: (url: string): AvatarEventStream => {
      opened.push(url);
      return stream;
    },
    emit(type: string, data: unknown): void {
      for (const listener of listeners.get(type) ?? []) listener({ data });
    },
  };
}

function page(body: string) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { url: 'http://localhost:5173/' });
  return dom.window.document;
}

const img = (doc: Document, id: string): HTMLImageElement =>
  doc.getElementById(id) as unknown as HTMLImageElement;

describe('installAvatarUpgrades', () => {
  it('opens no connection when the server reports no configured source', () => {
    const stream = fakeEventStream();
    installAvatarUpgrades(false, { document: page(''), openEventStream: stream.open });
    expect(stream.opened).toEqual([]);
  });

  it('listens on the session event stream when upgrades are possible', () => {
    const stream = fakeEventStream();
    installAvatarUpgrades(true, { document: page(''), openEventStream: stream.open });
    expect(stream.opened).toEqual(['/__pyric/events']);
  });

  it('reloads a matching avatar image, preserving its query string', () => {
    const doc = page(
      '<img id="a" src="/__pyric/assets/avatar/u1?d=seed&n=Ada&p=google.com">',
    );
    const stream = fakeEventStream();
    installAvatarUpgrades(true, { document: doc, openEventStream: stream.open });

    const before = img(doc, 'a').src;
    stream.emit('avatar-ready', JSON.stringify({ key: 'u1' }));
    const after = new URL(img(doc, 'a').src);

    expect(after.pathname).toBe('/__pyric/assets/avatar/u1');
    expect(after.searchParams.get('d')).toBe('seed');
    expect(after.searchParams.get('n')).toBe('Ada');
    expect(after.searchParams.get('p')).toBe('google.com');
    expect(after.searchParams.get('pyric-upgrade')).not.toBeNull();
    expect(img(doc, 'a').src).not.toBe(before);
  });

  it('matches a percent-encoded uid segment by decoding it', () => {
    const doc = page(`<img id="a" src="/__pyric/assets/avatar/${encodeURIComponent('u 1')}?d=s">`);
    const stream = fakeEventStream();
    installAvatarUpgrades(true, { document: doc, openEventStream: stream.open });

    stream.emit('avatar-ready', JSON.stringify({ key: 'u 1' }));
    expect(new URL(img(doc, 'a').src).searchParams.get('pyric-upgrade')).not.toBeNull();
  });

  it('leaves images for another uid, and non-avatar images, untouched', () => {
    const doc = page(
      '<img id="other" src="/__pyric/assets/avatar/u2?d=s">' +
        '<img id="plain" src="/logo.png">',
    );
    const stream = fakeEventStream();
    installAvatarUpgrades(true, { document: doc, openEventStream: stream.open });

    const otherBefore = img(doc, 'other').src;
    const plainBefore = img(doc, 'plain').src;
    stream.emit('avatar-ready', JSON.stringify({ key: 'u1' }));

    expect(img(doc, 'other').src).toBe(otherBefore);
    expect(img(doc, 'plain').src).toBe(plainBefore);
  });

  it('reloads every image bound to the same uid', () => {
    const doc = page(
      '<img id="a" src="/__pyric/assets/avatar/u1?d=s"><img id="b" src="/__pyric/assets/avatar/u1?d=s">',
    );
    const stream = fakeEventStream();
    installAvatarUpgrades(true, { document: doc, openEventStream: stream.open });

    stream.emit('avatar-ready', JSON.stringify({ key: 'u1' }));

    expect(new URL(img(doc, 'a').src).searchParams.get('pyric-upgrade')).not.toBeNull();
    expect(new URL(img(doc, 'b').src).searchParams.get('pyric-upgrade')).not.toBeNull();
  });

  it('a second upgrade of the same image changes its src again', () => {
    const doc = page('<img id="a" src="/__pyric/assets/avatar/u1?d=s">');
    const stream = fakeEventStream();
    installAvatarUpgrades(true, { document: doc, openEventStream: stream.open });

    stream.emit('avatar-ready', JSON.stringify({ key: 'u1' }));
    const first = img(doc, 'a').src;
    stream.emit('avatar-ready', JSON.stringify({ key: 'u1' }));

    expect(img(doc, 'a').src).not.toBe(first);
  });

  it('ignores a malformed payload without throwing and leaves the image alone', () => {
    const doc = page('<img id="a" src="/__pyric/assets/avatar/u1?d=s">');
    const stream = fakeEventStream();
    installAvatarUpgrades(true, { document: doc, openEventStream: stream.open });

    const before = img(doc, 'a').src;
    for (const payload of ['not json', '{"key":42}', '{}', 'null', '[]', undefined, 17]) {
      expect(() => stream.emit('avatar-ready', payload)).not.toThrow();
    }
    expect(img(doc, 'a').src).toBe(before);
  });
});
