/** Atomically acquire, release, or switch one member's color within a board. */
export function transitionClaim(sdk, db, { board, uid, expected, nextColor, read, stage, afterRead = async () => {} }) {
  const root = `pairedBoards/${board}`;
  return sdk.runTransaction(db, async tx => {
    const memberPath = `${root}/memberClaims/${uid}`;
    const member = await read(memberPath, () => tx.get(sdk.doc(db, memberPath)));
    const oldPath = member.color === null ? null : `${root}/colorClaims/${member.color}`;
    const nextPath = nextColor === null ? null : `${root}/colorClaims/${nextColor}`;
    const old = oldPath ? await read(oldPath, () => tx.get(sdk.doc(db, oldPath))) : null;
    const next = nextPath ? await read(nextPath, () => tx.get(sdk.doc(db, nextPath))) : null;
    await afterRead();
    const matches = expected === null ? member.color === null : member.color === expected.color && member.epoch === expected.epoch;
    if (!matches || (nextColor !== null && next?.uid !== null) || nextColor === member.color) return false;
    if (old && (old.uid !== uid || old.epoch !== member.epoch)) return false;
    const token = next ? { color: nextColor, epoch: next.epoch + 1 } : { color: null, epoch: 0 };
    const put = (path, data) => { stage(path, data); tx.set(sdk.doc(db, path), data); };
    if (old) put(oldPath, { uid: null, epoch: old.epoch });
    if (next) put(nextPath, { uid, epoch: token.epoch });
    put(memberPath, token);
    return token;
  });
}
