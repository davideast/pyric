import { CHIP_FONT_DATA } from './chip-font-data.js';

const installed = new WeakSet<Document>();

/** Register byte-backed fonts once per document, including inside Shadow DOM.
 * Binary FontFace sources require no URL request or external font service.
 * Separate family names prevent a host application's Geist from overriding us.
 */
export function installChipFonts(documentLike: Document): void {
  if (installed.has(documentLike)) return;
  const view = documentLike.defaultView;
  const Face = (view as (Window & { FontFace?: typeof FontFace }) | null)?.FontFace;
  if (!Face || !documentLike.fonts || !view) return;
  installed.add(documentLike);
  for (const { family, base64 } of CHIP_FONT_DATA) {
    const bytes = Uint8Array.from(view.atob(base64), (character) => character.charCodeAt(0));
    const face = new Face(family, bytes, { weight: '100 900', style: 'normal', display: 'swap' });
    documentLike.fonts.add(face);
    void face.load().catch(() => { documentLike.fonts.delete(face); });
  }
}
