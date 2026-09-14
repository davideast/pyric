/** Keep 32 calls below 24 MiB with room for the peer's correlation metadata. */
export function mcpByteWriteArgs(path: string, index: number) {
  const args = { path, data: { message: '' }, as: 'admin' };
  const isLast = index === 31;
  const targetBytes = isLast ? 768 * 1024 - 4096 : 768 * 1024;
  const remaining = targetBytes - Buffer.byteLength(JSON.stringify({ name: 'firestore_create_document', arguments: args }));
  args.data.message = 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
  return args;
}
