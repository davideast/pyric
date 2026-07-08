// Build the REAL denial fixtures BEFORE installing JSDOM globals.
// `pyric/rules`' OHM parser hits cross-realm checks that fail
// once JSDOM replaces `globalThis` (see bunfig.toml note + render-hook
// helper). Running the simulator here, pre-JSDOM, sidesteps that — the
// component itself never touches the parser, so DOM rendering is safe.
import { aliceDeniedUpdate, noMatchDenial, buildDenial, NOTES_RULES } from '../helpers/fixtures.js';
const ALICE = aliceDeniedUpdate();
const NO_MATCH = noMatchDenial();
const CLUSTER_SIBLING = buildDenial({
  rules: NOTES_RULES,
  method: 'update',
  path: 'notes/deI4Inwx',
  auth: { uid: 'alice', token: {} },
  requestData: { title: 'x', owner: 'carol' },
  resourceData: { title: 'y', owner: 'carol' },
});

// Now install JSDOM for React DOM rendering.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { DenialInspector } from '../../../src/rules/index.js';

afterEach(() => cleanup());

describe('<DenialInspector> — a real denial', () => {
  it('renders the deciding line marked deny and the unchecked line skipped', () => {
    const { container } = render(<DenialInspector denial={ALICE} />);
    const lines = Array.from(
      container.querySelectorAll('[data-pyric-rule-line]'),
    );
    const byNumber = (n: number) =>
      lines.find((l) => l.getAttribute('data-pyric-line-number') === String(n))!;
    expect(byNumber(6).getAttribute('data-pyric-line-verdict')).toBe('deny');
    expect(byNumber(5).getAttribute('data-pyric-line-verdict')).toBe('skip');
    // The deny line carries the badge.
    expect(byNumber(6).querySelector('[data-pyric-line-badge]')).not.toBeNull();
  });

  it('renders the expression trace with the deciding values', () => {
    const { container } = render(<DenialInspector denial={ALICE} />);
    const nodes = Array.from(
      container.querySelectorAll('[data-pyric-trace-node]'),
    );
    expect(nodes.length).toBeGreaterThan(0);
    const text = (sel: string) =>
      nodes
        .map((n) => ({
          src: n.querySelector('[data-pyric-trace-source]')?.textContent,
          val: n.querySelector('[data-pyric-trace-value]')?.textContent,
        }))
        .find((r) => r.src === sel);
    // The root condition resolved false.
    expect(text('request.auth.uid == resource.data.owner')?.val).toBe('false');
    // The two operands carry their real values.
    expect(text('request.auth.uid')?.val).toBe('"alice"');
    expect(text('resource.data.owner')?.val).toBe('"bob"');
    // The false root is flagged for styling.
    const root = nodes.find(
      (n) =>
        n.querySelector('[data-pyric-trace-source]')?.textContent ===
        'request.auth.uid == resource.data.owner',
    )!;
    expect(
      root
        .querySelector('[data-pyric-trace-value]')!
        .hasAttribute('data-pyric-false'),
    ).toBe(true);
    // Depth reflects the parent chain.
    expect(root.getAttribute('data-pyric-depth')).toBe('0');
    const uid = nodes.find(
      (n) =>
        n.querySelector('[data-pyric-trace-source]')?.textContent ===
        'request.auth.uid',
    )!;
    expect(uid.getAttribute('data-pyric-depth')).toBe('1');
  });

  it('renders data-in-scope and underlines the read leaf values', () => {
    const { container } = render(<DenialInspector denial={ALICE} />);
    const vars = Array.from(
      container.querySelectorAll('[data-pyric-scope-var]'),
    ).map((v) => v.getAttribute('data-pyric-scope-var'));
    expect(vars).toContain('request.auth');
    expect(vars).toContain('request.resource.data');
    expect(vars).toContain('resource.data');
    // The deciding values are marked as hits.
    const hits = Array.from(
      container.querySelectorAll('[data-pyric-scope-hit]'),
    ).map((h) => h.textContent);
    expect(hits).toContain('"alice"'); // request.auth.uid
    expect(hits).toContain('"bob"'); // resource.data.owner
  });

  it('wires the re-run + edit-rule callbacks', () => {
    let ranAs: string | null = null;
    let edited = false;
    const { container } = render(
      <DenialInspector
        denial={ALICE}
        onRerunAs={(uid) => (ranAs = uid)}
        onTestEditedRule={() => (edited = true)}
      />,
    );
    const rerun = container.querySelector('[data-pyric-rerun]')!;
    expect(rerun).not.toBeNull();
    fireEvent.click(rerun.querySelector('[data-pyric-rerun-as]')!);
    // The lens is `{ as: 'alice' }`, so re-run targets alice.
    expect(ranAs).toBe('alice');
    fireEvent.click(rerun.querySelector('[data-pyric-test-edited-rule]')!);
    expect(edited).toBe(true);
  });

  it('renders the cluster and selects a sibling', () => {
    let selected: string | null = null;
    const { container } = render(
      <DenialInspector
        denial={ALICE}
        cluster={[CLUSTER_SIBLING]}
        onSelectCluster={(d) => (selected = d.path)}
      />,
    );
    const items = Array.from(
      container.querySelectorAll('[data-pyric-cluster-item]'),
    );
    expect(items.length).toBe(1);
    fireEvent.click(items[0]);
    expect(selected).toBe('notes/deI4Inwx');
  });
});

describe('<DenialInspector> — a no-match denial', () => {
  it('renders path resolution and no evaluation trace', () => {
    const { container } = render(<DenialInspector denial={NO_MATCH} />);
    const resolution = container.querySelector('[data-pyric-path-resolution]');
    expect(resolution).not.toBeNull();
    const attempts = Array.from(
      resolution!.querySelectorAll('[data-pyric-path-attempt]'),
    );
    expect(attempts.length).toBeGreaterThan(0);
    // The mismatch reason is surfaced on the attempt.
    expect(attempts[0].getAttribute('data-pyric-reason')).toBe('literal-mismatch');
    expect(attempts[0].getAttribute('data-pyric-matched-segments')).toBe('0/2');
    // No expression trace for a default-deny.
    expect(container.querySelector('[data-pyric-trace-node]')).toBeNull();
  });
});
