/** Strip Google AI (`models/`) or Vertex AI (`publishers/google/models/`) prefixes from a model resource name. */
const VERTEX_GOOGLE_MODEL_PREFIX = 'publishers/google/models/';
const GOOGLE_MODEL_PREFIX = 'models/';

export function stripModelResourcePrefix(modelResource: string): string {
  if (modelResource.startsWith(VERTEX_GOOGLE_MODEL_PREFIX)) {
    return modelResource.slice(VERTEX_GOOGLE_MODEL_PREFIX.length);
  }
  if (modelResource.startsWith(GOOGLE_MODEL_PREFIX)) {
    return modelResource.slice(GOOGLE_MODEL_PREFIX.length);
  }
  return modelResource;
}
