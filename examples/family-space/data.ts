import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Query,
} from "firebase/firestore";
import {
  getBytes,
  getMetadata,
  getStorage,
  ref,
  uploadBytes,
} from "firebase/storage";
export const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "demo",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "kin-demo.firebaseapp.com",
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "kin-demo",
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "kin-demo.appspot.com",
});
export const auth = getAuth(app),
  db = import.meta.env.VITE_FIREBASE_DATABASE_ID
    ? getFirestore(app, import.meta.env.VITE_FIREBASE_DATABASE_ID)
    : getFirestore(app),
  storage = getStorage(app);
export const FAMILY = "parkers";
export const base = `families/${FAMILY}`;
export type Member = {
  id: string;
  name: string;
  role: "parent" | "kid";
  avatar: string;
};
export type Post = {
  id: string;
  authorId: string;
  title: string;
  body: string;
  kind: "image" | "video" | "article" | "event";
  status: "published" | "pending" | "rejected";
  audience: string[];
  createdAt: number;
  mediaPath: string;
  cover: string;
  url: string;
  eventAt: string;
  location: string;
};
export type Comment = {
  id: string;
  authorId: string;
  text: string;
  createdAt: number;
};
export type ChatMessage = Comment & {
  mediaPath: string;
  mediaType: "" | "image" | "video" | "audio";
};
export function watchList<T>(
  source: Query,
  next: (items: T[]) => void,
  fail: (e: Error) => void,
) {
  return onSnapshot(
    source,
    (snap) => next(snap.docs.map((d) => ({ ...d.data(), id: d.id }) as T)),
    fail,
  );
}
export function watchMembers(
  next: (items: Member[]) => void,
  fail: (e: Error) => void,
) {
  return watchList(collection(db, `${base}/members`), next, fail);
}
export function watchPosts(
  member: Member,
  next: (items: Post[]) => void,
  fail: (e: Error) => void,
) {
  const source = collection(db, `${base}/posts`);
  if (member.role === "parent") return watchList(source, next, fail);
  const batches: Post[][] = [[], [], []];
  const send = () =>
    next([...new Map(batches.flat().map((p) => [p.id, p])).values()]);
  const sources = [
    query(
      source,
      where("status", "==", "published"),
      where("audience", "array-contains", "family"),
    ),
    query(
      source,
      where("status", "==", "published"),
      where("audience", "array-contains", member.id),
    ),
    query(source, where("authorId", "==", member.id)),
  ];
  const stops = sources.map((q, i) =>
    watchList<Post>(
      q,
      (items) => {
        batches[i] = items;
        send();
      },
      fail,
    ),
  );
  return () => stops.forEach((stop) => stop());
}
export async function savePost(
  member: Member,
  values: Omit<Post, "id" | "authorId" | "createdAt" | "mediaPath">,
  existing?: Post,
  file?: File,
) {
  const target = existing
    ? doc(db, `${base}/posts/${existing.id}`)
    : doc(db, `${base}/posts/${crypto.randomUUID()}`);
  const content = {
    ...values,
    authorId: existing?.authorId ?? member.id,
    createdAt: existing?.createdAt ?? Date.now(),
    mediaPath: existing?.mediaPath ?? "",
    status: member.role === "parent" ? values.status : "pending",
    audience:
      member.role === "parent"
        ? values.audience
        : (existing?.audience ?? ["family"]),
  };
  await setDoc(target, content);
  if (file) {
    const path = `${base}/posts/${target.id}/${crypto.randomUUID()}`;
    await upload(path, file);
    await updateDoc(target, { mediaPath: path });
  }
  return target.id;
}
export const removePost = (id: string) =>
  deleteDoc(doc(db, `${base}/posts/${id}`));
export const moderate = (
  id: string,
  status: Post["status"],
  audience: string[],
) => updateDoc(doc(db, `${base}/posts/${id}`), { status, audience });
export const markViewed = (id: string, uid: string) =>
  setDoc(doc(db, `${base}/posts/${id}/views/${uid}`), {
    viewedAt: serverTimestamp(),
  });
export const addComment = (id: string, uid: string, text: string) =>
  addDoc(collection(db, `${base}/posts/${id}/comments`), {
    authorId: uid,
    text: text.trim(),
    createdAt: Date.now(),
  });
export const editComment = (post: string, id: string, text: string) =>
  updateDoc(doc(db, `${base}/posts/${post}/comments/${id}`), {
    text: text.trim(),
  });
export const removeComment = (post: string, id: string) =>
  deleteDoc(doc(db, `${base}/posts/${post}/comments/${id}`));
export async function upload(path: string, file: Blob) {
  if (file.size >= 25 * 1024 * 1024)
    throw new Error("Choose a file smaller than 25 MB.");
  if (!/^(image|video|audio)\//.test(file.type))
    throw new Error("Choose a photo, video, or audio recording.");
  await uploadBytes(ref(storage, path), file, { contentType: file.type });
}
export async function mediaObjectUrl(path: string, kind: string) {
  const target = ref(storage, path);
  const [bytes, metadata] = await Promise.all([
    getBytes(target, 25 * 1024 * 1024),
    getMetadata(target),
  ]);
  return URL.createObjectURL(
    new Blob([bytes], {
      type: metadata.contentType || "application/octet-stream",
    }),
  );
}
export async function sendChat(uid: string, text: string, file?: File | Blob) {
  let mediaPath = "",
    mediaType = "";
  if (file) {
    mediaType = file.type.split("/")[0];
    mediaPath = `${base}/chat/${uid}/${crypto.randomUUID()}`;
    await upload(mediaPath, file);
  }
  await addDoc(collection(db, `${base}/chat`), {
    authorId: uid,
    text: text.trim(),
    createdAt: Date.now(),
    mediaPath,
    mediaType,
  });
}
export function safeUrl(url: string) {
  try {
    const parsed = new URL(url, location.origin);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}
