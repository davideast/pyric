import type { EvalTask } from '../types.js';

const PDF_BYTES = 'JVBERi0xLjQK';

const task: EvalTask = {
  id: 'hand-support-a-link-to-the-onboarding-pdf',
  prompt:
    'Support keeps asking for docs/onboarding.pdf. Give me a link I can paste into the ticket rather than the file itself. The Firestore side of the ticket is fine, leave it alone.',
  seed: {
    storage: [{ path: 'docs/onboarding.pdf', contentBase64: PDF_BYTES, contentType: 'application/pdf' }],
    firestore: { 'tickets/t1': { subject: 'where is onboarding', status: 'open' } },
  },
  acceptedFirstOperations: ['get_storage_download_url'],
  assert: (state) => {
    const minted = state.calls.find((call) => call.operation === 'get_storage_download_url');
    if (minted === undefined) return 'no download URL was asked for';
    if (!minted.ok) return 'the download URL call failed';
    const url = (minted.data as { url?: string } | undefined)?.url;
    if (typeof url !== 'string' || !url.startsWith('data:application/pdf')) {
      return 'the URL does not name the stored PDF';
    }
    if (!url.endsWith(PDF_BYTES)) return 'the URL does not carry the stored bytes';
    const ticket = state.firestore.get('tickets/t1');
    if (ticket?.status !== 'open') return 'the ticket document was changed';
    return true;
  },
  tags: ['storage', 'read'],
};

export default task;
