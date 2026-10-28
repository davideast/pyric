/**
 * `string.trim()` as Firestore and Storage rules evaluate it: strip every
 * code unit at or below U+0020 (the C0 controls and space) from both ends,
 * as Java's `String.trim()` does.
 *
 * JavaScript's `String.prototype.trim()` is a different set: it strips
 * Unicode white space (NBSP, U+3000, the byte-order mark) and keeps most C0
 * controls. The 2026-10-27 captures `split-and-trim-edges` (Firestore) and
 * `xref-shared-language-semantics` (Storage) show production keeping NBSP,
 * U+3000 and the BOM and stripping U+0001 and U+001F.
 */
export function trimRulesString(subject: string): string {
  let start = 0;
  let end = subject.length;
  while (start < end && isTrimmed(subject.charCodeAt(start))) start++;
  while (end > start && isTrimmed(subject.charCodeAt(end - 1))) end--;
  return subject.slice(start, end);
}

function isTrimmed(codeUnit: number): boolean {
  return codeUnit <= 0x20;
}
