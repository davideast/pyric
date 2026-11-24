import { getApp, initializeApp } from 'firebase/app';
import {
  breadcrumbs,
  flush,
  getCrashlytics,
  log,
  recordError,
} from 'firebase/crashlytics';
import {
  FirebaseErrorHandler,
  getRawPath,
  getSafeRoutePath,
  provideCrashlytics,
} from 'firebase/crashlytics/angular';
import {
  CrashlyticsRoutes as NextCrashlyticsRoutes,
  getParameterizedRoute,
} from 'firebase/crashlytics/next-navigation';
import { FirebaseCrashlytics } from 'firebase/crashlytics/react';
import { CrashlyticsRoutes as RouterCrashlyticsRoutes } from 'firebase/crashlytics/react-router';

const APP_ID = '1:1340:web:fb13browser';
const REACT_ELEMENT_SYMBOL = Symbol.for('react.transitional.element');

const crashlyticsOptions = {
  appVersion: '13.4.0-web-e2e',
  region: 'europe-west1',
  customAttributes: { surface: 'storefront-web' },
  features: [breadcrumbs()],
};

// Exercise Angular's lazy getApp() provider factory before initializeApp() runs.
const angularProviders = provideCrashlytics(() => getApp(), crashlyticsOptions);

const app = initializeApp({
  projectId: 'demo-crashlytics-fb13',
  appId: APP_ID,
});

function makeReactElement(type, props) {
  return {
    $$typeof: REACT_ELEMENT_SYMBOL,
    type,
    key: null,
    ref: null,
    props,
  };
}

function RouteStub() {
  return null;
}

window.runHandledAndFrameworkFlow = async function runHandledAndFrameworkFlow() {
  const reactMountResult = FirebaseCrashlytics({
    firebaseApp: app,
    crashlyticsOptions,
  });

  const parameterizedRoute = getParameterizedRoute(
    '/orders/ord-77/items/sku-9',
    { orderId: 'ord-77', itemId: 'sku-9' },
  );

  window.history.pushState({}, '', '/checkout');
  const nextRoutesResult = NextCrashlyticsRoutes({
    firebaseApp: app,
    crashlyticsOptions,
  });

  const orderViewLeaf = makeReactElement('section', { id: 'order-detail' });
  const matchedRouteTree = RouterCrashlyticsRoutes({
    firebaseApp: app,
    crashlyticsOptions,
    location: { pathname: '/orders/ord-77' },
    children: [
      makeReactElement(RouteStub, {
        path: '/orders/:orderId',
        element: orderViewLeaf,
      }),
    ],
  });

  const angularRawPath = getRawPath('/catalog;filter=featured/shoes?size=10#top');
  const angularSafePath = getSafeRoutePath({
    url: '/catalog/shoes',
    navigated: true,
    routerState: {
      snapshot: {
        root: {
          firstChild: {
            firstChild: null,
            pathFromRoot: [
              { routeConfig: null },
              { routeConfig: { path: 'catalog/:category' } },
            ],
          },
          pathFromRoot: [{ routeConfig: null }],
        },
      },
    },
    events: {
      subscribe() {
        return { unsubscribe() {} };
      },
    },
  });

  const crashlytics = getCrashlytics(app, crashlyticsOptions);
  log(crashlytics, 'payment-submitted', { method: 'card', cents: 4999 });
  recordError(crashlytics, new RangeError('card-declined'), {
    retryable: true,
  });

  const ngErrorHandler = new FirebaseErrorHandler(app, crashlyticsOptions);
  ngErrorHandler.handleError(new Error('angular-zone-error'));

  let externalEndpointRefused = false;
  try {
    getCrashlytics(app, {
      endpointUrl: 'https://clienttelemetry.googleapis.com/v1/logs',
    });
  } catch (error) {
    externalEndpointRefused =
      error instanceof Error && /endpointUrl/.test(error.message);
  }

  let mismatchedOptionsRefused = false;
  try {
    getCrashlytics(app, { region: 'asia-east1' });
  } catch (error) {
    mismatchedOptionsRefused =
      error instanceof Error &&
      error.message === 'getCrashlytics() cannot be called with different options';
  }

  await flush(crashlytics);

  let matchedLeafId = null;
  if (
    matchedRouteTree &&
    matchedRouteTree.props &&
    matchedRouteTree.props.children &&
    matchedRouteTree.props.children.props
  ) {
    matchedLeafId = matchedRouteTree.props.children.props.id;
  }

  return {
    angularBrand: angularProviders['\u0275brand'],
    reactMountResult,
    nextRoutesResult,
    parameterizedRoute,
    matchedLeafId,
    angularRawPath,
    angularSafePath,
    externalEndpointRefused,
    mismatchedOptionsRefused,
  };
};

window.triggerUnhandledErrorsAndFlush = async function triggerUnhandledErrorsAndFlush() {
  const crashlytics = getCrashlytics(app, crashlyticsOptions);
  log(crashlytics, 'before-unhandled-window-error', { stage: 'dom-error' });

  await new Promise((resolve) => {
    setTimeout(() => {
      setTimeout(resolve, 25);
      throw new TypeError('unhandled-window-crash');
    }, 0);
  });

  log(crashlytics, 'before-unhandled-rejection', { stage: 'promise-rejection' });

  await new Promise((resolve) => {
    setTimeout(() => {
      setTimeout(resolve, 25);
      Promise.reject(new URIError('unhandled-promise-crash'));
    }, 0);
  });

  await flush(crashlytics);
  return { flushed: true };
};

const statusNode = document.getElementById('status');
if (statusNode) {
  statusNode.textContent = 'ready';
}
window.crashlyticsReady = true;
