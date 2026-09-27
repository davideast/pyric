/** The Data view works through its host alone, without the rest of the chip. */
import { expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createSdkActivityJournal } from 'pyric/sandbox/internal';
import { createChipDataView, type ChipDataViewHost } from '../../../src/serve/runtime/chip-data-view.js';
import { createListenerMode } from '../../../src/serve/runtime/listener-mode.js';

function page() {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { url: 'http://localhost/' });
  const document = dom.window.document;
  const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
  const journal = createSdkActivityJournal();
  const calls: string[] = [];
  let traffic: { service: string; target: string } | null = null;
  const host: ChipDataViewHost = {
    document,
    build: (onChange) => createListenerMode({
      activity: journal, document, onChange, paintStorage: null, incidents: () => [],
      commits: { available: () => false, reason: () => 'no React', subscribe: () => () => {}, dispose: () => {} },
      subscribeEvents: (callback) => { callback([], { history: true }); return () => {}; },
    }),
    render: () => { calls.push('render'); draw(); },
    showing: () => true,
    reveal: () => { calls.push('reveal'); },
    showTraffic: (source) => { traffic = source; },
    missingIndex: () => false,
    indexBlock: () => '',
    indexAction: () => '',
  };
  const view = createChipDataView(host);
  const draw = () => {
    const { body, bar } = view.view();
    root.innerHTML = `<div class="view">${body}</div>${bar}`;
    view.bind(root);
  };
  return { dom, journal, view, root, calls, draw, traffic: () => traffic };
}

it('renders sources, opens a source, and hands Traffic the source through its host', () => {
  const { dom, journal, view, root, draw, traffic } = page();
  try {
    expect(view.mode()).not.toBeNull();
    const read = journal.begin({ app: {}, method: 'getDoc', kind: 'operation', source: { service: 'firestore', target: 'notes/one', key: 'notes/one' } });
    read.delivered({ exists: () => true, data: () => ({}) }, {});
    read.complete();
    draw();
    expect(view.outlines().map(outline => outline.target)).toEqual(['notes/one']);
    root.querySelector<HTMLButtonElement>('[data-listener-row]')!.click();
    expect(root.querySelector('[data-sources-back]')).not.toBeNull();
    root.querySelector<HTMLAnchorElement>('[data-source-traffic]')!.click();
    expect(traffic()).toEqual({ service: 'firestore', target: 'notes/one' });
  } finally {
    view.dispose();
    journal.dispose();
    dom.window.close();
  }
});

it('has no mode and says so when the page has no event source', () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const view = createChipDataView({
    document: dom.window.document, render() {}, showing: () => false, reveal() {}, showTraffic() {},
    missingIndex: () => false, indexBlock: () => '', indexAction: () => '',
  });
  expect(view.mode()).toBeNull();
  expect(view.outlines()).toEqual([]);
  view.dispose();
  dom.window.close();
});
