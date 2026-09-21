import { initializeSandbox } from 'pyric/sandbox';
import * as firestore from 'pyric/firestore';
import * as database from 'pyric/database';
import { createIndexConfigClient } from '../../packages/cli/src/serve/runtime/index-config-client.ts';

export type Message = { id: number; who: string; name: string; text: string; time: string }
function messageValue(value: unknown): Message {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'number'
    || !('who' in value) || typeof value.who !== 'string' || !('name' in value) || typeof value.name !== 'string'
    || !('text' in value) || typeof value.text !== 'string' || !('time' in value) || typeof value.time !== 'string') {
    throw new Error('The message data is invalid. Reset the demo data.');
  }
  return { id: value.id, who: value.who, name: value.name, text: value.text, time: value.time };
}
export type ChatService = 'firestore' | 'rtdb';
export interface ListenOptions { mode: 'value' | 'children'; scope: 'messages' | 'conversation' }
const path = 'conversations/design';
const key = (id: number) => `m${String(id).padStart(4, '0')}`;

/** Both adapters feed the same rendering boundary; all user actions use public SDK calls. */
export function createChatData(sandbox: ReturnType<typeof initializeSandbox>, service: ChatService, initial: Message[]) {
  const db = firestore.getFirestore(sandbox);
  const rtdb = database.getDatabase(sandbox);
  const indexes = createIndexConfigClient(fetch.bind(globalThis));
  const seed = service === 'firestore' ? initial : Array.from({ length: 30 }, (_, index) => ({
    ...initial[index % initial.length]!, id: index + 1,
    text: `Message ${index + 1}. ${initial[index % initial.length]!.text} ${'This conversation includes design notes and review feedback. '.repeat(4)}`,
  }));
  let stops: (() => void)[] = [];
  let count = 10;
  let lastOptions: ListenOptions = { mode: 'value', scope: 'messages' };
  let receive: ((messages: Message[]) => void) | undefined;
  let receipt: ((count: number) => void) | undefined;
  let owner: { kind: 'component'; name: string; element: Element };
  let latest = new Map<number, Message>();
  const older = new Map<number, Message>();
  const seededPaths = new Set(seed.map(message => `${path}/messages/${message.id}`));
  function seedData() {
    if (service === 'firestore') {
      database.sandbox.setData(rtdb, { presence: { online: true }, typing: { design: false } });
      for (const document of seededPaths) sandbox.admin.deleteDocument(document);
      for (const message of seed) sandbox.admin.setDocument(`${path}/messages/${message.id}`, message);
      sandbox.admin.setDocument(`${path}/read-receipts/current`, { count: 0 });
    } else {
      database.sandbox.setData(rtdb, { conversations: { design: {
        messages: Object.fromEntries(seed.map(message => [key(message.id), message])),
        receipts: { count: 0 }, topic: 'Design review', notes: 'Shared conversation context. '.repeat(100),
      } }, presence: { online: true }, typing: { design: false } });
    }
  }
  seedData();
  function messagesQuery() {
    return database.query(database.ref(rtdb, `${path}/messages`), database.orderByChild('id'), database.limitToLast(count));
  }
  function publish() {
    receive?.([...new Map([...older, ...latest]).values()].sort((a, b) => a.id - b.id));
  }
  function replace(value: unknown) {
    latest = new Map(Object.values((value ?? {}) as Record<string, unknown>).map(value => { const message = messageValue(value); return [message.id, message]; }));
    publish();
  }
  function stop() { for (const unsubscribe of stops) unsubscribe(); stops = []; }
  function start(options = lastOptions) {
    stop(); lastOptions = options; latest.clear();
    if (service === 'firestore') {
      stops.push(firestore.onSnapshot(firestore.collection(db, `${path}/messages`), { owner }, snapshot => {
        replace(Object.fromEntries((snapshot as firestore.QuerySnapshot).docs.map(doc => [doc.id, doc.data()])));
      }));
      stops.push(firestore.onSnapshot(firestore.doc(db, `${path}/read-receipts/current`), { owner }, snapshot => {
        receipt?.(Number((snapshot as firestore.DocumentSnapshot).data()?.count ?? 0));
      }));
      return;
    }
    if (options.scope === 'conversation') {
      stops.push(database.onValue(database.ref(rtdb, path), snapshot => {
        replace(snapshot.child('messages').val()); receipt?.(Number(snapshot.child('receipts/count').val() ?? 0));
      }, { owner }));
      return;
    }
    const query = messagesQuery();
    if (options.mode === 'value') {
      stops.push(database.onValue(query, snapshot => replace(snapshot.val()), { owner }));
    } else {
      const upsert = (snapshot: database.DataSnapshot) => {
        const message = messageValue(snapshot.val()); latest.set(message.id, message); publish();
      };
      stops.push(database.onChildAdded(query, upsert, { owner }));
      stops.push(database.onChildChanged(query, upsert, { owner }));
      stops.push(database.onChildRemoved(query, snapshot => { latest.delete((messageValue(snapshot.val())).id); publish(); }, { owner }));
    }
    stops.push(database.onValue(database.ref(rtdb, `${path}/receipts`), snapshot => receipt?.(Number(snapshot.child('count').val() ?? 0)), { owner }));
  }
  return {
    initialCount: seed.length,
    messagePath: () => service === 'rtdb' && lastOptions.scope === 'conversation' ? `/${path}` : `${service === 'rtdb' ? '/' : ''}${path}/messages`,
    connect(nextOwner: typeof owner, onMessages: NonNullable<typeof receive>, onReceipt: NonNullable<typeof receipt>) {
      owner = nextOwner; receive = onMessages; receipt = onReceipt; start();
    }, start, stop,
    async rules() {
      const config = await indexes.read('rtdb');
      if (!config || !('rules' in config.config)) throw new Error('Database rules are unavailable.');
      database.sandbox.setRules(rtdb, config.config);
    },
    async write(message: Message) {
      if (service === 'rtdb') await database.set(database.ref(rtdb, `${path}/messages/${key(message.id)}`), message);
      else { seededPaths.add(`${path}/messages/${message.id}`); await firestore.setDoc(firestore.doc(db, `${path}/messages/${message.id}`), message); }
    },
    async markRead(value: number) {
      if (service === 'rtdb') await database.set(database.ref(rtdb, `${path}/receipts/count`), value);
      else await firestore.setDoc(firestore.doc(db, `${path}/read-receipts/current`), { count: value });
    },
    async read() {
      if (service === 'firestore') return (await firestore.getDocs(firestore.query(firestore.collection(db, `${path}/messages`)))).size;
      return (await database.get(messagesQuery())).size;
    },
    async loadOlder() {
      const first = Math.min(...latest.keys(), ...older.keys());
      const snapshot = await database.get(database.query(database.ref(rtdb, `${path}/messages`), database.orderByChild('id'), database.endBefore(first), database.limitToLast(10)));
      snapshot.forEach(child => { const message = messageValue(child.val()); older.set(message.id, message); });
      publish(); return snapshot.size;
    },
    async queryIndex() {
      await this.rules();
      return (await database.get(database.query(database.ref(rtdb, `${path}/messages`), database.orderByChild('who'), database.equalTo('alice')))).size;
    },
    reset() { stop(); older.clear(); count = 10; seedData(); start(); },
  };
}
