import { expect, test } from 'bun:test';
import { observeMessageDisplay } from '../../../src/serve/worker/client/messaging-display.js';

test('native display evidence follows the message tag and preserves rejection', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'registration');
  const denied = new DOMException('Permission denied', 'NotAllowedError');
  const registration = {
    async showNotification(title: string, _options?: NotificationOptions): Promise<void> {
      const rejected = title === 'Denied';
      if (rejected) throw denied;
    },
  };
  Object.defineProperty(globalThis, 'registration', { configurable: true, value: registration });
  const alice: string[] = [];
  const david: string[] = [];
  const stopAlice = observeMessageDisplay('alice-message', stage => alice.push(stage));
  const stopDavid = observeMessageDisplay('david-message', stage => david.push(stage));
  try {
    await registration.showNotification('Accepted', { tag: 'alice-message' });
    await expect(registration.showNotification('Denied', { tag: 'david-message' })).rejects.toBe(denied);
    await registration.showNotification('Unrelated', { tag: 'other-message' });
    expect(alice).toEqual(['display-requested', 'display-accepted']);
    expect(david).toEqual(['display-requested', 'display-rejected']);
    stopAlice();
    await registration.showNotification('Finished', { tag: 'alice-message' });
    expect(alice).toHaveLength(2);
  } finally {
    stopAlice();
    stopDavid();
    const restore = previous !== undefined;
    if (restore) Object.defineProperty(globalThis, 'registration', previous);
    else Reflect.deleteProperty(globalThis, 'registration');
  }
});


test('a read-only native API does not prevent message delivery', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'registration');
  let displays = 0;
  const registration = Object.freeze({ async showNotification() { displays += 1; } });
  Object.defineProperty(globalThis, 'registration', { configurable: true, value: registration });
  const stages: string[] = [];
  try {
    const stop = observeMessageDisplay('message', stage => stages.push(stage));
    await registration.showNotification();
    stop();
    expect(displays).toBe(1);
    expect(stages).toEqual([]);
  } finally {
    const restore = previous !== undefined;
    if (restore) Object.defineProperty(globalThis, 'registration', previous);
    else Reflect.deleteProperty(globalThis, 'registration');
  }
});
