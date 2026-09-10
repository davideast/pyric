import type { EvalTask } from '../types.js';

const LOGO_BYTES = 'iVBORw0KGgo=';

const task: EvalTask = {
  id: 'link-the-logo-into-the-welcome-email',
  prompt:
    'The welcome email template needs a URL for branding/logo.png, not the raw bytes. Get me the download URL the sandbox serves for it.',
  seed: {
    storage: [{ path: 'branding/logo.png', contentBase64: LOGO_BYTES, contentType: 'image/png' }],
  },
  acceptedFirstOperations: ['get_storage_download_url'],
  assert: (state) => {
    const minted = state.calls.find((call) => call.operation === 'get_storage_download_url');
    if (minted === undefined) return 'no download URL was asked for';
    if (!minted.ok) return 'the download URL call failed';
    const url = (minted.data as { url?: string } | undefined)?.url;
    if (typeof url !== 'string') return 'the call reached no URL to report';
    // The sandbox mints a data URI carrying the object's own bytes, so the URL
    // resolving is a property of the string rather than of a later fetch.
    if (!url.startsWith('data:image/png')) return `the URL is not the stored object: ${url}`;
    if (!url.endsWith(LOGO_BYTES)) return 'the URL does not carry the stored bytes';
    return true;
  },
  tags: ['storage', 'read'],
};

export default task;
