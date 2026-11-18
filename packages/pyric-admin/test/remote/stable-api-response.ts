/**
 * Strips clock-dependent `generation`, `timeCreated`, and `updated` fields
 * from `Bucket.getFiles` `apiResponse.items` when comparing two independently
 * seeded sandboxes (remote vs local).
 */
export function stableGetFilesApiResponse(response: unknown): Record<string, unknown> {
  const raw = response as {
    kind: string;
    prefixes?: string[];
    nextPageToken?: string;
    items?: Array<Record<string, unknown>>;
  };
  const out: Record<string, unknown> = { kind: raw.kind };
  if (raw.prefixes !== undefined) out.prefixes = raw.prefixes;
  if (raw.nextPageToken !== undefined) out.nextPageToken = raw.nextPageToken;
  if (raw.items !== undefined) {
    out.items = raw.items.map((item) => ({
      name: item.name,
      bucket: item.bucket,
      metageneration: item.metageneration,
      size: item.size,
      contentType: item.contentType,
      md5Hash: item.md5Hash,
      generationIsDigits: typeof item.generation === 'string' && /^\d+$/.test(item.generation),
    }));
  }
  return out;
}
