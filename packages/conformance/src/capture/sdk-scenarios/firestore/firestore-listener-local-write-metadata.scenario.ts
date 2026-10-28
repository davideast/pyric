import type { DocumentChange } from 'firebase/firestore';
import type { FirestoreScenario } from '../scenario-types.ts';

const change = (c: DocumentChange) => `${c.type}:${c.doc.id}:${c.doc.metadata.hasPendingWrites}`;

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-listener-local-write-metadata',
    rowIds: ['firestore#listener-local-write-pending', 'firestore#docchanges-metadata-ack'],
    description: 'One setDoc observed by a doc listener and a query listener, each with and without includeMetadataChanges. Records hasPendingWrites and fromCache per snapshot, and per-doc hasPendingWrites in docChanges (with includeMetadataChanges on the metadata listener).',
  },
  async run({ db, fs, base, wait }) {
    const path = `${base}/meta`;
    const target = fs.doc(db, `${path}/a`);
    const log: Record<string, unknown[]> = { docDefault: [], docMeta: [], qDefault: [], qMeta: [] };
    const stops = [
      fs.onSnapshot(target, (s) => log.docDefault!.push({ exists: s.exists(), pw: s.metadata.hasPendingWrites, fc: s.metadata.fromCache })),
      fs.onSnapshot(target, { includeMetadataChanges: true }, (s) => log.docMeta!.push({ exists: s.exists(), pw: s.metadata.hasPendingWrites, fc: s.metadata.fromCache })),
      fs.onSnapshot(fs.collection(db, path), (s) => log.qDefault!.push({ size: s.size, pw: s.metadata.hasPendingWrites, changes: s.docChanges().map(change) })),
      fs.onSnapshot(fs.collection(db, path), { includeMetadataChanges: true }, (s) => log.qMeta!.push({
        size: s.size,
        pw: s.metadata.hasPendingWrites,
        fc: s.metadata.fromCache,
        changes: s.docChanges({ includeMetadataChanges: true }).map(change),
      })),
    ];
    await wait(1500);
    await fs.setDoc(target, { v: 1 });
    await wait(1500);
    stops.forEach((stop) => stop());
    return log;
  },
};
