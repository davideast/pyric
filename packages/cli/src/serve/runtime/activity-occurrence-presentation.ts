import type { ActivityOccurrence } from './activity-occurrences.js';

interface OccurrencePresentation { readonly label: string; readonly outcome: string }
const readLabels: Readonly<Record<string, string>> = {
  getBytes: 'Download bytes', getBlob: 'Download file', getDownloadURL: 'Get download URL',
  getMetadata: 'Read metadata', listAll: 'List files', uploadBytes: 'Upload file',
  uploadString: 'Upload file', uploadBytesResumable: 'Upload file',
  updateMetadata: 'Update metadata', deleteObject: 'Delete file',
  getDoc: 'Read document', getDocs: 'Read collection', get: 'Read database',
  getDocFromCache: 'Read document', getDocFromServer: 'Read document',
  getDocsFromCache: 'Read collection', getDocsFromServer: 'Read collection',
  getCountFromServer: 'Read count', getAggregateFromServer: 'Read aggregate',
};

/** UI wording is derived from facts, never used to determine lifecycle state. */
export function presentActivityOccurrence(occurrence: ActivityOccurrence): OccurrencePresentation {
  const renderOutcome = occurrence.render === 'observed' ? 'Rendered' : 'No render observed';
  switch (occurrence.kind) {
    case 'subscription-failure':
      return { label: 'Request failed', outcome: 'Failed' };
    case 'subscription-delivery':
      return { label: 'Update received', outcome: renderOutcome };
    case 'subscription-state':
      return { label: 'Subscription', outcome: occurrence.lifecycle === 'active' ? 'Listening' : 'Stopped' };
    case 'operation': {
      const label = readLabels[occurrence.event.method] ?? 'Read result';
      if (occurrence.lifecycle === 'failed') return { label: 'Request failed', outcome: 'Failed' };
      if (occurrence.event.phase === 'progress' && occurrence.lifecycle === 'pending') return { label: 'Upload progress', outcome: renderOutcome };
      if (occurrence.lifecycle === 'pending') return { label, outcome: 'Pending' };
      return { label, outcome: renderOutcome };
    }
  }
}
