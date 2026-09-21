const encoder = new TextEncoder();
export async function contentHash(text: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
// UTF-8 chunks, not JS character counts. JSON is reconstructed before parsing.
export function chunks(text: string) {
  const result: string[] = [];
  let chunk = "",
    bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > 256 * 1024) {
      result.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  result.push(chunk);
  return result;
}
