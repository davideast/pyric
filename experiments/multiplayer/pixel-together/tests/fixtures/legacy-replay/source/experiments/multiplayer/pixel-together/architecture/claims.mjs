/** A persistent generation distinguishes ownership sessions even for the same UID. */
export function acquireClaim(sdk, db, { path, uid, fenced = false, read, stage, afterRead = async () => {} }) {
  return sdk.runTransaction(db, async tx => {
    const ref = sdk.doc(db, path);
    const current = await read(() => tx.get(ref));
    await afterRead();
    if (current?.uid) return false;
    const data = fenced ? { uid, epoch: (current?.epoch ?? 0) + 1 } : { uid };
    stage(data);
    tx.set(ref, data);
    return fenced ? data.epoch : true;
  });
}
