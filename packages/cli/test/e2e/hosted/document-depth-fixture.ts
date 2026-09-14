export type DocumentShape = 'maps' | 'arrays' | 'escaped';

/** The encoded root counts once; escaping a marker-shaped map adds its fields container. */
export function nestedDocument(encodedDepth: number, shape: DocumentShape): Record<string, unknown> {
  let nested: unknown = 'leaf';
  let remaining = encodedDepth - 1;
  const needsEscaping = shape === 'escaped';
  if (needsEscaping) remaining -= 1;
  let hasContainersRemaining = remaining > 0;
  while (hasContainersRemaining) {
    const needsArray = shape === 'arrays' && remaining % 2 === 0;
    if (needsArray) nested = [nested];
    else nested = { nested };
    remaining -= 1;
    hasContainersRemaining = remaining > 0;
  }
  const data: Record<string, unknown> = { nested };
  if (needsEscaping) data.type = 'ordinary';
  return data;
}
