/**
 * Node-only credential surface (`pyric-tools/credentials/node`): the filesystem
 * adapters + the local-token resolver. Separate from the browser-safe
 * `pyric-tools/credentials` barrel because these touch the filesystem
 * (`~/.pyric/credentials.json`, ADC). Server-side only.
 */
export {
  resolveLocalAccessToken,
  type LocalAccessToken,
  type LocalCredentialSource,
  type ResolveLocalTokenOptions,
} from './resolve-local-token.js';
export { fileCredentialStore, defaultCredentialPath } from './file-store.js';
export { fromAdc } from './from-adc.js';
