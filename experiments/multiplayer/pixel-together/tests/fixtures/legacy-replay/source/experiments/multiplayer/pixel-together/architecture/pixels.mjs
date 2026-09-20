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
