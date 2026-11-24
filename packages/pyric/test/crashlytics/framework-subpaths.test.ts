import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteApp, getApp, getApps, initializeApp } from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/internal.js';
import * as crashlyticsAngular from '../../src/crashlytics/angular.js';
import { getCrashlyticsBroker } from '../../src/crashlytics/broker.js';
import { breadcrumbs, flush, getCrashlytics } from '../../src/crashlytics/index.js';
import * as crashlyticsNextNavigation from '../../src/crashlytics/next-navigation.js';
import * as crashlyticsReact from '../../src/crashlytics/react.js';
import * as crashlyticsReactRouter from '../../src/crashlytics/react-router.js';
import { resolveClientApp } from '../../src/sandbox/internal/client-app.js';

const REACT_ELEMENT_SYMBOL = Symbol.for('react.transitional.element');

function makeElement(
  type: unknown,
  props: Record<string, unknown> = {},
): {
  $$typeof: symbol;
  type: unknown;
  key: null;
  ref: null;
  props: Record<string, unknown>;
} {
  return {
    $$typeof: REACT_ELEMENT_SYMBOL,
    type,
    key: null,
    ref: null,
    props,
  };
}

describe('pyric/crashlytics framework subpath mirrors', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(async () => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
    await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
    resetAppRegistryForTests();
  });

  test('preserves use client directive prologue on React and Next.js framework modules', () => {
    const distDir = join(import.meta.dir, '../../dist/crashlytics');
    for (const file of ['react.js', 'next-navigation.js', 'react-router.js']) {
      const source = readFileSync(join(distDir, file), 'utf8');
      expect(source.startsWith("'use client';"), file).toBe(true);
    }
    const angularSource = readFileSync(join(distDir, 'angular.js'), 'utf8');
    expect(angularSource.startsWith("'use client';")).toBe(false);
  });

  test('exports exact runtime symbol sets matching @firebase/crashlytics@0.2.0', () => {
    expect(Object.keys(crashlyticsReact).sort()).toEqual(['FirebaseCrashlytics']);
    expect(Object.keys(crashlyticsNextNavigation).sort()).toEqual([
      'CrashlyticsRoutes',
      'getParameterizedRoute',
    ]);
    expect(Object.keys(crashlyticsReactRouter).sort()).toEqual(['CrashlyticsRoutes']);
    expect(Object.keys(crashlyticsAngular).sort()).toEqual([
      'FirebaseErrorHandler',
      'getRawPath',
      'getSafeRoutePath',
      'provideCrashlytics',
      'setupCrashlyticsRoutes',
    ]);
  });

  test('firebase/crashlytics/react FirebaseCrashlytics initializes Crashlytics, returns null, and captures unhandled window errors', async () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    (globalThis as { window?: unknown }).window = {
      location: { pathname: '/checkout' },
      addEventListener(type: string, fn: (event: unknown) => void) {
        let bucket = listeners.get(type);
        if (bucket === undefined) {
          bucket = new Set();
          listeners.set(type, bucket);
        }
        bucket.add(fn);
      },
      removeEventListener(type: string, fn: (event: unknown) => void) {
        listeners.get(type)?.delete(fn);
      },
    };

    const app = initializeApp({
      projectId: 'demo-crashlytics-react',
      appId: '1:101:web:react',
    });
    const reactOptions = {
      appVersion: '4.2.0',
      region: 'us-central1',
      customAttributes: { framework: 'react' },
    };
    const rendered = crashlyticsReact.FirebaseCrashlytics({
      firebaseApp: app,
      crashlyticsOptions: reactOptions,
    });
    expect(rendered).toBeNull();

    for (const listener of listeners.get('error') ?? []) {
      listener({ error: new TypeError('uncaught-react-boom') });
    }
    await flush(getCrashlytics(app, reactOptions));

    const runtime = resolveClientApp(app);
    expect(runtime).toBeDefined();
    if (!runtime) {
      throw new Error('expected sandbox runtime for app');
    }
    const state = getCrashlyticsBroker(runtime.sandbox).getState('1:101:web:react');
    expect(state.appVersion).toBe('4.2.0');
    expect(state.region).toBe('us-central1');
    expect(state.reports).toHaveLength(1);
    expect(state.reports[0]?.name).toBe('TypeError');
    expect(state.reports[0]?.message).toBe('uncaught-react-boom');
    expect(state.reports[0]?.fatal).toBe(true);
    expect(state.reports[0]?.attributes).toEqual({ framework: 'react' });
  });

  test('firebase/crashlytics/next-navigation formats parameterized routes and logs deduplicated view-boundary breadcrumbs', async () => {
    expect(crashlyticsNextNavigation.getParameterizedRoute(null, null)).toBe('/');
    expect(crashlyticsNextNavigation.getParameterizedRoute('/orders', {})).toBe('/orders');
    expect(
      crashlyticsNextNavigation.getParameterizedRoute('/users/42/details', { id: '42' }),
    ).toBe('/users/:id/details');
    expect(
      crashlyticsNextNavigation.getParameterizedRoute('/docs/sdk/web/crashlytics', {
        slug: ['sdk', 'web', 'crashlytics'],
      }),
    ).toBe('/docs/:slug*');
    expect(
      crashlyticsNextNavigation.getParameterizedRoute('/items/a+b.c/edit', { id: 'a+b.c' }),
    ).toBe('/items/:id/edit');

    const mockWindow = { location: { pathname: '/dashboard' } };
    (globalThis as { window?: unknown }).window = mockWindow;

    const app = initializeApp({
      projectId: 'demo-crashlytics-next',
      appId: '1:102:web:next',
    });
    const opts = { features: [breadcrumbs()] };

    expect(
      crashlyticsNextNavigation.CrashlyticsRoutes({
        firebaseApp: app,
        crashlyticsOptions: opts,
      }),
    ).toBeNull();
    // Re-rendering on the same pathname does not emit a duplicate breadcrumb.
    expect(
      crashlyticsNextNavigation.CrashlyticsRoutes({
        firebaseApp: app,
        crashlyticsOptions: opts,
      }),
    ).toBeNull();

    mockWindow.location.pathname = '/settings';
    expect(
      crashlyticsNextNavigation.CrashlyticsRoutes({
        firebaseApp: app,
        crashlyticsOptions: opts,
      }),
    ).toBeNull();

    await flush(getCrashlytics(app, opts));
    const runtime = resolveClientApp(app);
    if (!runtime) {
      throw new Error('expected sandbox runtime for app');
    }
    const state = getCrashlyticsBroker(runtime.sandbox).getState('1:102:web:next');
    expect(state.logs.map((entry) => entry.message)).toEqual([
      'Navigation event',
      'Navigation event',
    ]);
    expect(state.logs.map((entry) => entry.attributes)).toEqual([
      { 'app.screen.id': '/dashboard' },
      { 'app.screen.id': '/settings' },
    ]);
  });

  test('firebase/crashlytics/react-router matches Route trees, records view-boundary breadcrumbs, and forwards boundary errors to recordError', async () => {
    const app = initializeApp({
      projectId: 'demo-crashlytics-rr',
      appId: '1:103:web:rr',
    });
    const RouteStub = function Route(): null {
      return null;
    };
    const HomeLeaf = makeElement('div', { id: 'home-view' });
    const UserLeaf = makeElement('div', { id: 'user-view' });

    const routes = [
      makeElement(RouteStub, { path: '/', element: HomeLeaf }),
      makeElement(RouteStub, {
        path: '/users',
        children: [makeElement(RouteStub, { path: ':userId', element: UserLeaf })],
      }),
    ];

    const rrOptions = { features: [breadcrumbs()] };
    const emptyResult = crashlyticsReactRouter.CrashlyticsRoutes({
      firebaseApp: app,
      crashlyticsOptions: rrOptions,
    });
    expect(emptyResult).toBeNull();

    const matched = crashlyticsReactRouter.CrashlyticsRoutes({
      firebaseApp: app,
      crashlyticsOptions: rrOptions,
      location: { pathname: '/users/abc-99' },
      children: routes,
    });
    expect(matched).not.toBeNull();
    if (matched === null) {
      throw new Error('expected matched element');
    }
    expect(matched.props.children).toBe(UserLeaf);

    // Invoke the error boundary class mounted by CrashlyticsRoutes to verify
    // componentDidCatch records the error in Crashlytics and re-throws.
    const BoundaryCtor = matched.type as new (props: {
      onError: (err: unknown) => void;
      children: unknown;
    }) => {
      componentDidCatch(err: unknown): void;
      render(): unknown;
    };
    const boundaryInstance = new BoundaryCtor(matched.props);
    expect(boundaryInstance.render()).toBe(UserLeaf);
    expect(() => boundaryInstance.componentDidCatch(new ReferenceError('route-crash'))).toThrow(
      'route-crash',
    );

    await flush(getCrashlytics(app, rrOptions));
    const runtime = resolveClientApp(app);
    if (!runtime) {
      throw new Error('expected sandbox runtime for app');
    }
    const state = getCrashlyticsBroker(runtime.sandbox).getState('1:103:web:rr');
    expect(state.logs.map((entry) => entry.attributes)).toEqual([
      { 'app.screen.id': '/' },
      { 'app.screen.id': '/users/:userId' },
    ]);
    expect(state.reports).toHaveLength(1);
    expect(state.reports[0]?.name).toBe('ReferenceError');
    expect(state.reports[0]?.message).toBe('route-crash');
  });

  test('firebase/crashlytics/angular provides EnvironmentProviders, strips matrix params, tracks router events, and handles errors', async () => {
    expect(crashlyticsAngular.getRawPath('/users;role=admin/42;tab=bio?sort=asc#top')).toBe(
      '/users/42',
    );
    expect(crashlyticsAngular.getRawPath('?only=query#hash')).toBe('/');

    const app = initializeApp({
      projectId: 'demo-crashlytics-ng',
      appId: '1:104:web:ng',
    });
    const ngOptions = {
      appVersion: '9.0.0',
      features: [breadcrumbs()],
    };
    const providers = crashlyticsAngular.provideCrashlytics(() => app, ngOptions);
    expect((providers as unknown as Record<string, unknown>)['\u0275brand']).toBe(
      'EnvironmentProviders',
    );
    expect(Array.isArray((providers as unknown as Record<string, unknown>)['\u0275providers'])).toBe(
      true,
    );

    const errorHandler = new crashlyticsAngular.FirebaseErrorHandler(app, ngOptions);
    errorHandler.handleError(new Error('ng-zone-failure'));

    let routeListener: ((event: unknown) => void) | undefined;
    let unsubscribed = false;
    let teardownCallback: (() => void) | undefined;
    let activeConfigPath = 'orders/:orderId';

    const router: crashlyticsAngular.AngularRouterLike = {
      url: '/orders/100?view=compact',
      navigated: true,
      get routerState() {
        const leaf: crashlyticsAngular.AngularRouteSnapshotLike = {
          firstChild: null,
          pathFromRoot: [
            { routeConfig: null },
            { routeConfig: { path: activeConfigPath } },
          ],
        };
        const rootSnap: crashlyticsAngular.AngularRouteSnapshotLike = {
          firstChild: leaf,
          pathFromRoot: [{ routeConfig: null }],
        };
        return { snapshot: { root: rootSnap } };
      },
      events: {
        subscribe(listener) {
          routeListener = listener;
          return {
            unsubscribe() {
              unsubscribed = true;
            },
          };
        },
      },
    };

    expect(crashlyticsAngular.getSafeRoutePath(router)).toBe('/orders/:orderId');

    crashlyticsAngular.setupCrashlyticsRoutes({
      firebaseApp: app,
      router,
      destroyRef: {
        onDestroy(cb) {
          teardownCallback = cb;
        },
      },
      crashlyticsOptions: ngOptions,
    });

    // Duplicate navigation to the same raw path (different query param) is ignored.
    routeListener?.({ urlAfterRedirects: '/orders/100?view=expanded' });

    // Navigating to a new raw path emits a fresh view-boundary log.
    activeConfigPath = 'orders/:orderId/receipt';
    routeListener?.({ urlAfterRedirects: '/orders/100/receipt;print=1' });

    teardownCallback?.();
    expect(unsubscribed).toBe(true);

    await flush(getCrashlytics(app, ngOptions));
    const runtime = resolveClientApp(app);
    if (!runtime) {
      throw new Error('expected sandbox runtime for app');
    }
    const state = getCrashlyticsBroker(runtime.sandbox).getState('1:104:web:ng');
    expect(state.appVersion).toBe('9.0.0');
    expect(state.reports).toHaveLength(1);
    expect(state.reports[0]?.message).toBe('ng-zone-failure');
    expect(state.logs.map((entry) => entry.attributes)).toEqual([
      { 'app.screen.id': '/orders/:orderId' },
      { 'app.screen.id': '/orders/:orderId/receipt' },
    ]);
  });

  test('firebase/crashlytics/angular provideCrashlytics supports lazy getApp() factories before initializeApp()', async () => {
    const lazyOptions = {
      appVersion: '9.1.0',
      region: 'europe-west1',
      features: [breadcrumbs()],
    };
    const lazyProviders = crashlyticsAngular.provideCrashlytics(
      () => getApp(),
      lazyOptions,
    );
    expect((lazyProviders as unknown as Record<string, unknown>)['\u0275brand']).toBe(
      'EnvironmentProviders',
    );

    const app = initializeApp({
      projectId: 'demo-crashlytics-ng-lazy',
      appId: '1:106:web:nglazy',
    });
    await Promise.resolve();

    const handler = new crashlyticsAngular.FirebaseErrorHandler(app, lazyOptions);
    handler.handleError(new Error('lazy-bootstrap-error'));
    await flush(getCrashlytics(app, lazyOptions));

    const runtime = resolveClientApp(app);
    if (!runtime) {
      throw new Error('expected sandbox runtime for app');
    }
    const state = getCrashlyticsBroker(runtime.sandbox).getState('1:106:web:nglazy');
    expect(state.appVersion).toBe('9.1.0');
    expect(state.region).toBe('europe-west1');
    expect(state.reports).toHaveLength(1);
    expect(state.reports[0]?.message).toBe('lazy-bootstrap-error');
  });

  test('rejects non-loopback endpointUrl across all four framework subpaths', () => {
    const app = initializeApp({
      projectId: 'demo-crashlytics-guard',
      appId: '1:105:web:guard',
    });
    const badOptions = {
      endpointUrl: 'https://clienttelemetry.googleapis.com/v1/logs',
    };
    expect(() =>
      crashlyticsReact.FirebaseCrashlytics({
        firebaseApp: app,
        crashlyticsOptions: badOptions,
      }),
    ).toThrow(/endpointUrl/);
    expect(() =>
      crashlyticsNextNavigation.CrashlyticsRoutes({
        firebaseApp: app,
        crashlyticsOptions: badOptions,
      }),
    ).toThrow(/endpointUrl/);
    expect(() =>
      crashlyticsReactRouter.CrashlyticsRoutes({
        firebaseApp: app,
        crashlyticsOptions: badOptions,
      }),
    ).toThrow(/endpointUrl/);
    expect(() => crashlyticsAngular.provideCrashlytics(() => app, badOptions)).toThrow(
      /endpointUrl/,
    );
  });
});
