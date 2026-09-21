/** Recompute a single pixel intent on every transaction callback, including retries. */
export function paintGridTransaction(sdk, db, index, color, { read, stage, afterRead = async () => {} }) {
  return sdk.runTransaction(db, async tx => {
    const ref = sdk.doc(db, 'boards/main');
    const data = await read(() => tx.get(ref));
    await afterRead();
    data.grid[index] = color;
    stage(data);
    tx.set(ref, data);
  });
}

/** Independent pixel storage: same-cell overwrites remain an explicit policy choice. */
export function writePixel(sdk, db, path, color) {
  return sdk.setDoc(sdk.doc(db, path), { color });
}

/** Submit a prepared drawing intent; current backend Rules decide its validity. */
export function drawClaimedPixel(sdk, db, payload, { read, stage, afterRead = async () => {} }) {
  return sdk.runTransaction(db, async tx => {
    await read(`fencedClaims/${payload.color}`, () => tx.get(sdk.doc(db, `fencedClaims/${payload.color}`)));
    await read('fencedPixels/0', () => tx.get(sdk.doc(db, 'fencedPixels/0')));
    await afterRead();
    stage(payload);
    tx.set(sdk.doc(db, 'fencedPixels/0'), payload);
  });
}
