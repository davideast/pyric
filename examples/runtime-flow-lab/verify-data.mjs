/** Resolve actual SDK registrations instead of assigning fixture listener IDs. */
export async function chatListenerIds(page) {
  return page.evaluate(() => {
    const records = globalThis[Symbol.for('pyric.sdk-activity')].records();
    const paths = {
      messages: 'conversations/design/messages',
      presence: 'presence',
      typing: 'typing/design',
      receipts: 'conversations/design/read-receipts/current',
    };
    return Object.fromEntries(Object.entries(paths).map(([name, path]) => {
      const record = records.find(record => record.kind === 'subscription' && record.target.replace(/^\/+/, '') === path);
      if (!record) throw new Error(`Missing SDK subscription for ${path}`);
      return [name, record.transportId ?? record.id];
    }));
  });
}
