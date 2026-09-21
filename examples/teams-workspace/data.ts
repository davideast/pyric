import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import * as fs from "firebase/firestore";
import * as rt from "firebase/database";
import {
  getStorage,
  ref as fileRef,
  uploadBytes,
  getDownloadURL,
} from "firebase/storage";
import { firebaseConfig } from "./firebase-config";
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app),
  db = fs.getFirestore(app),
  rtdb = rt.getDatabase(app);
const storage = getStorage(app);
const path = (channel: string) =>
  `workspaces/orbit/channels/${channel}/messages`;
export const people = [
  { uid: "david", name: "David East", role: "Designer" },
  { uid: "alice", name: "Alice Chen", role: "Product lead" },
  { uid: "marcus", name: "Marcus Williams", role: "Engineer" },
  { uid: "avery", name: "Avery Jordan", role: "Guest" },
];
export const channels = [
  {
    id: "design",
    name: "design-studio",
    description:
      "A little space for big ideas. Share the work, make it better.",
    color: "#a58bf5",
  },
  {
    id: "general",
    name: "team-lounge",
    description: "Updates, hellos, and everything in between.",
    color: "#78bba6",
  },
  {
    id: "launch",
    name: "fall-launch",
    description: "Bringing the next chapter of Orbit into the world.",
    color: "#e7ac77",
  },
];
export type Message = {
  authorName?: string;
  id: string;
  author: string;
  text: string;
  created: number;
  reactions: number;
  parent: string;
  attachment?: string;
  fileName?: string;
};
export function listenMessages(
  channel: string,
  next: (messages: Message[]) => void,
  fail: (error: Error) => void,
) {
  return fs.onSnapshot(
    fs.query(fs.collection(db, path(channel)), fs.orderBy("created")),
    (snapshot) => {
      next(
        (snapshot as fs.QuerySnapshot).docs.map(
          (doc) => ({ ...doc.data(), id: doc.id }) as Message,
        ),
      );
    },
    (error) => fail(error instanceof Error ? error : new Error(String(error))),
  );
}
export function listenRealtime(
  location: string,
  next: (value: Record<string, string>) => void,
) {
  return rt.onValue(rt.ref(rtdb, location), (snapshot) => {
    const value = snapshot.val();
    next(
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          )
        : {},
    );
  });
}
export async function send(
  channel: string,
  author: string,
  text: string,
  parent = "",
  file?: File,
) {
  let attachment: string | undefined;
  if (file) {
    const uploaded = await uploadBytes(
      fileRef(storage, `workspace/${crypto.randomUUID()}/${file.name}`),
      file,
    );
    attachment = await getDownloadURL(uploaded.ref);
  }
  const value = {
    author,
    authorName:
      auth.currentUser?.displayName ?? auth.currentUser?.email ?? "Teammate",
    text,
    parent,
    created: Date.now(),
    reactions: 0,
    ...(attachment ? { attachment, fileName: file!.name } : {}),
  };
  const messageId = crypto.randomUUID();
  await fs.setDoc(fs.doc(db, `${path(channel)}/${messageId}`), value);
  // The message remains sent if a secondary notification request fails.
  try {
    await rt.set(rt.ref(rtdb, `mentionRequests/${author}/${messageId}`), channel);
  } catch (error) {
    console.warn("Message sent, but mention notification could not be queued.", error);
  }
  await rt.set(
    rt.ref(rtdb, `receipts/${channel}/${author}`),
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );
}
export const reactTo = (channel: string, message: Message) =>
  fs.updateDoc(fs.doc(db, `${path(channel)}/${message.id}`), {
    reactions: fs.increment(1),
  });
export const presence = (uid: string, value: string) =>
  rt.set(rt.ref(rtdb, `presence/${uid}`), value);
export const typing = (channel: string, uid: string, value: boolean) =>
  rt.set(rt.ref(rtdb, `typing/${channel}/${uid}`), value ? "typing" : "");
export async function searchMessages(term: string) {
  const results = await Promise.all(
    channels.map(async (channel) => {
      const result = await fs.getDocs(
        fs.query(fs.collection(db, path(channel.id))),
      );
      return result.docs.map(
        (doc) =>
          ({ ...doc.data(), id: doc.id, channel: channel.id }) as Message & {
            channel: string;
          },
      );
    }),
  );
  return results
    .flat()
    .filter((message) =>
      message.text.toLowerCase().includes(term.toLowerCase()),
    );
}

export function connectPresence(uid: string) {
  const location = rt.ref(rtdb, `presence/${uid}`);
  void rt.onDisconnect(location).set("offline");
  void rt.set(location, "online");
  return () => {
    if (auth.currentUser?.uid === uid)
      void rt.set(location, "offline").catch(() => {});
  };
}
