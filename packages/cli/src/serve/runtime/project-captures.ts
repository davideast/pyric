import { serviceLabel } from './service-presentation.js';
import type { CaptureEntry } from '../rate-capture-store.js';

/** Project transport; a standalone page can still import and download files. */
export function projectCaptures(fetcher: typeof fetch) {
  async function request(id?: string, text?: string, method = text === undefined ? 'GET' : 'POST') {
    const init = await fetcher('/__pyric/init.json');
    if (!init.ok || !init.headers.get('content-type')?.includes('application/json')) return null;
    const config = await init.json();
    if (typeof config.sessionToken !== 'string' || config.rateCaptures !== true) return null;
    const response = await fetcher(`/__pyric/rate-captures${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
      method,
      headers: { 'x-pyric-session-token': config.sessionToken, 'content-type': 'application/json' }, body: text,
    });
    if (response.status === 404 || !response.headers.get('content-type')?.includes('application/json')) {
      if (response.ok || response.status === 404) return null;
      throw new Error('Unable to connect to project captures. Reload to reconnect.');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Unable to access project captures.');
    return data;
  }
  return {
    async list(): Promise<CaptureEntry[] | null> { return request(); },
    async save(text: string): Promise<CaptureEntry | null> { return request(undefined, text); },
    async rename(id: string, name: string): Promise<CaptureEntry> {
      const result = await request(id, JSON.stringify({ name }), 'PATCH');
      if (!result) throw new Error('Project capture is unavailable.');
      return result;
    },
    async remove(id: string): Promise<void> {
      const result = await request(id, JSON.stringify({ confirm: true }), 'DELETE');
      if (!result) throw new Error('Project capture is unavailable.');
    },
    async read(id: string): Promise<string> {
      const result = await request(id);
      if (!result) throw new Error('Project capture is unavailable.');
      return JSON.stringify(result);
    },
  };
}

export function captureList(entries: readonly CaptureEntry[] | null, loading: boolean, escape: (s: string) => string): string {
  if (loading) return '<p role="status">Loading captures…</p>';
  if (entries === null) return '<p>Project storage is unavailable. Open a capture from a file.</p>';
  if (!entries.length) return '<p>No saved captures.</p>';
  return `<div class="rows">${entries.map(entry => `<button type="button" class="row" data-project-capture="${escape(entry.id)}"><div class="row-content"><strong class="c1 wide">${escape(entry.name || serviceLabel(entry.service))}</strong><small class="s1 wide">${entry.name ? `${serviceLabel(entry.service)} / ` : ''}${escape(new Date(entry.from).toLocaleString())} / ${entry.duration}s${entry.incident ? ` / ${escape(entry.incident)}` : ''}</small></div></button>`).join('')}</div>`;
}

export function captureEditor(entry: CaptureEntry, deleting: boolean, escape: (text: string) => string): string {
  const name = escape(entry.name || serviceLabel(entry.service));
  if (deleting) return `<section class="section"><h3>Delete capture?</h3><p class="capture-name">${name}</p><p>This removes the saved snapshot from the project. The running sandbox is unaffected.</p></section>`;
  return `<section class="section"><div class="capture-name-form"><label for="capture-name">Name</label><input id="capture-name" data-capture-name type="text" maxlength="80" value="${escape(entry.name ?? '')}" placeholder="${name}" autocomplete="off"></div></section>`;
}
