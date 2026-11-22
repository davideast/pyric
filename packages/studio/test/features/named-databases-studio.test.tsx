// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MutationObserver = dom.window.MutationObserver;
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createAppForSandbox } from 'pyric/app/internal';
import { getAuth } from 'pyric/auth';
import {
  doc,
  getAdminFirestore,
  getDoc,
  getFirestore,
  setDoc,
} from 'pyric/firestore';
import { declareFirestoreDatabase, getDatabaseEnv } from 'pyric/firestore/internal';
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';
import { getAdminStorageSandbox } from 'pyric/storage/internal';

import { FirestoreDatabaseBar } from '../../src/features/data/FirestoreDatabaseBar.js';
import {
  listDocumentsForBrowse,
  scopeHandlesForDatabase,
  type StudioDataHandles,
} from '../../src/features/data/sandbox.js';
import { selectActivity } from '../../src/features/home/activity.js';
import {
  DenialDetail,
  explainDenial,
  rerunAgainstRules,
  ruleVariables,
  selectDenials,
} from '../../src/features/rules-debug/index.js';
import { snapshotWithNamedFirestore } from '../../src/shell/saved-state-branches.js';
import {
  filterByFirestoreDatabase,
  observedFirestoreDatabases,
} from '../../src/features/traffic/firestore-database-filter.js';
import { subjectTarget } from '../../src/features/traffic/verdict.js';
import { describeRuntimeFirestoreDatabases } from '../../src/shell/firestore-databases.js';

afterEach(() => cleanup());

const DEFAULT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read, write: if request.auth.uid == 'alice'; }
  }
}`;

const REPORTS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read, write: if request.auth.uid == 'bob'; }
  }
}`;

describe('Studio named-database routing, feed, traffic, denials, and runtime chip', () => {
  it('scopes StudioDataHandles per database and renders FirestoreDatabaseBar', async () => {
    const sandbox = initializeSandbox();
    declareFirestoreDatabase(sandbox, 'reports');
    const app = createAppForSandbox(sandbox, { projectId: 'studio-test' }, 'studio-named-app');
    const defaultEnv = getDatabaseEnv(sandbox);
    const baseHandles: StudioDataHandles = {
      sandbox,
      app,
      firestore: getFirestore(sandbox),
      adminFirestore: getAdminFirestore(sandbox.withAuth(null)),
      auth: getAuth(sandbox),
      storage: getAdminStorageSandbox(sandbox.withAuth(null)),
      listRootCollections: () => defaultEnv.listRootCollections(),
      listSubcollections: (p) => defaultEnv.listSubcollections(p),
      listDocuments: (c) => listDocumentsForBrowse(defaultEnv, c),
    };

    const reportsHandles = scopeHandlesForDatabase(baseHandles, 'reports');
    await setDoc(doc(baseHandles.adminFirestore, 'items/shared'), { db: 'default' });
    await setDoc(doc(reportsHandles.adminFirestore, 'reportsOnly/doc1'), { db: 'reports' });

    expect(baseHandles.listRootCollections()).toEqual(['items']);
    expect(reportsHandles.listRootCollections()).toEqual(['reportsOnly']);
    expect((await getDoc(doc(reportsHandles.adminFirestore, 'items/shared'))).exists()).toBe(false);

    const chosen: Array<string | undefined> = [];
    const statuses = [
      { id: '(default)', rulesDeployed: true, rulesStatusLabel: 'rules deployed' },
      { id: 'reports', rulesDeployed: false, rulesStatusLabel: 'no rules deployed' },
    ];
    const { container } = render(
      <FirestoreDatabaseBar
        databases={statuses}
        selectedDatabase="reports"
        onSelectDatabase={(next) => chosen.push(next)}
      />,
    );
    expect(
      container.querySelector('[data-pyric-ui="firestore-database-rules-status"]')?.textContent,
    ).toBe('reports: no rules deployed');
    fireEvent.click(container.querySelector('[data-firestore-database-option="(default)"]')!);
    expect(chosen).toEqual([undefined]);

    const chip = describeRuntimeFirestoreDatabases(statuses);
    expect(chip).toEqual({
      label: '2 databases',
      title:
        'Declared Firestore databases: (default) (rules deployed), reports (no rules deployed).',
    });
    expect(describeRuntimeFirestoreDatabases([statuses[0]!])).toBeNull();
  });

  it('projects database onto Home activity rows, Traffic filters/targets, and Denial explanations', async () => {
    const sandbox = initializeSandbox();
    declareFirestoreDatabase(sandbox, 'reports');
    getDatabaseEnv(sandbox).deployRules(DEFAULT_RULES);
    getDatabaseEnv(sandbox, 'reports').deployRules(REPORTS_RULES);

    const events: SandboxEvent[] = [];
    sandbox.onEvent((ev) => events.push(ev));

    await setDoc(
      doc(getFirestore(sandbox.withAuth({ uid: 'alice' })), 'items/default-1'),
      { ok: true },
    );
    await setDoc(
      doc(getFirestore(sandbox.withAuth({ uid: 'bob' }), 'reports'), 'items/report-1'),
      { ok: true },
    );
    await expect(
      getDoc(doc(getFirestore(sandbox.withAuth({ uid: 'alice' }), 'reports'), 'items/report-1')),
    ).rejects.toThrow(/denied by rules|Missing or insufficient permissions/);

    const activity = selectActivity(events);
    const reportsWriteRow = activity.find((r) => r.summary.includes('items/report-1') && !r.denied);
    const defaultWriteRow = activity.find((r) => r.summary.includes('items/default-1'));
    expect(reportsWriteRow?.database).toBe('reports');
    expect(reportsWriteRow?.summary).toContain('[reports]');
    expect(reportsWriteRow?.target).toEqual({
      tab: 'firestore',
      rest: ['items', 'report-1'],
      query: { database: 'reports' },
    });
    expect(defaultWriteRow?.database).toBeUndefined();
    expect(defaultWriteRow?.summary).toBe('set /items/default-1');

    const trafficSample = [
      { id: '1', service: 'firestore', method: 'get', path: 'items/a' },
      { id: '2', service: 'firestore', database: 'reports', method: 'get', path: 'items/b' },
      { id: '3', service: 'storage', method: 'get', path: 'files/c' },
    ];
    expect(observedFirestoreDatabases(trafficSample)).toEqual(['reports']);
    expect(filterByFirestoreDatabase(trafficSample, 'reports').map((e) => e.id)).toEqual(['2']);
    expect(filterByFirestoreDatabase(trafficSample, '(default)').map((e) => e.id)).toEqual(['1']);
    expect(
      subjectTarget({
        service: 'firestore',
        method: 'get',
        path: 'items/b',
        database: 'reports',
      }),
    ).toEqual({
      tab: 'firestore',
      rest: ['items', 'b'],
      query: { database: 'reports' },
    });

    const denials = selectDenials(events);
    expect(denials.length).toBe(1);
    const reportDenial = denials[0]!;
    expect(reportDenial.database).toBe('reports');

    const explanation = explainDenial(reportDenial);
    expect(explanation.database).toBe('reports');
    expect(explanation.ruleset).toBe('firestore:reports ruleset');
    expect(explanation.headline).toContain('database "reports" (firestore:reports ruleset)');

    const vars = ruleVariables(reportDenial);
    expect(vars[0]).toEqual({ name: 'database', present: true, value: 'reports' });

    const { container } = render(
      <DenialDetail denial={reportDenial} rulesSource={REPORTS_RULES} />,
    );
    expect(
      container.querySelector('[data-pyric-ui="denial-database-chip"]')?.textContent,
    ).toBe('reports (firestore:reports ruleset)');
  });

  it('re-runs a named-database denial against candidate rules and diffs that database instead of (default)', async () => {
    const sandbox = initializeSandbox();
    declareFirestoreDatabase(sandbox, 'reports');
    getDatabaseEnv(sandbox).deployRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`);
    getDatabaseEnv(sandbox, 'reports').deployRules(REPORTS_RULES);

    await setDoc(doc(getAdminFirestore(sandbox.withAuth(null)), 'items/report-1'), {
      owner: 'default-only',
    });
    await setDoc(doc(getAdminFirestore(sandbox.withAuth(null), 'reports'), 'items/report-1'), {
      owner: 'bob',
    });

    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    await setDoc(
      doc(getFirestore(sandbox.withAuth({ uid: 'alice' }), 'reports'), 'items/report-1'),
      { owner: 'alice', patched: true },
    ).catch(() => {});

    const denials = selectDenials(events);
    expect(denials.length).toBe(1);
    const denial = denials[0]!;
    expect(denial.database).toBe('reports');

    const candidateAllowAlice = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read, write: if request.auth.uid == 'alice'; }
  }
}`;
    const saved = snapshotWithNamedFirestore(sandbox);
    const rerun = await rerunAgainstRules(saved, denial, candidateAllowAlice, sandbox);
    expect(rerun.result.outcome).toBe('allow');
    expect(rerun.diff.some((d) => d.path === 'items/report-1' && d.field === 'owner' && d.before === 'bob' && d.after === 'alice')).toBe(true);
    expect(getDatabaseEnv(sandbox, 'reports').getDocument('items/report-1')).toEqual({
      owner: 'bob',
    });
  });
});
