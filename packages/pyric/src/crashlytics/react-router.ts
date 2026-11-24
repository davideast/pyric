'use client';
/**
 * Sandbox mirror of `firebase/crashlytics/react-router`
 * (`@firebase/crashlytics@0.2.0` / `firebase@13.4.0`).
 *
 * Zero hard dependency on `react` or `react-router-dom`: matches `<Route>` JSX
 * children against the active location, emits view-boundary breadcrumbs when
 * `breadcrumbs()` is enabled, and wraps rendered route elements in a React
 * class error boundary that forwards render errors to `recordError()`.
 */
import type { FirebaseApp } from '../app/types.js';
import { getCrashlytics, log, recordError } from './client.js';
import {
  currentBrowserPathname,
  emitViewBoundaryIfChanged,
  matchReactRouterChildren,
  type CrashlyticsFrameworkDriver,
} from './framework-routes.js';
import type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
} from './types.js';

export type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
};

/** Structural React element shape compatible with `@types/react` without importing `react`. */
export interface CrashlyticsReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: any;
  key: string | null;
}

/** Structural `Location` shape compatible with `react-router-dom`'s `RoutesProps.location`. */
export interface CrashlyticsRouteLocation {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
  key: string;
}

/** Props accepted by {@link CrashlyticsRoutes} on `firebase/crashlytics/react-router`. */
export interface ReactRouterCrashlyticsRoutesProps {
  firebaseApp: FirebaseApp;
  crashlyticsOptions?: CrashlyticsOptions;
  children?: unknown;
  location?: Partial<CrashlyticsRouteLocation> | string;
}

interface BoundaryProps {
  onError: (error: unknown) => void;
  children: unknown;
}

interface BoundaryState {
  error: unknown;
}

interface ReactUpdaterLike {
  enqueueSetState?: (
    publicInstance: unknown,
    partialState: Partial<BoundaryState>,
    callback: (() => void) | undefined,
    callerName: string,
  ) => void;
}

class CrashlyticsErrorBoundary {
  readonly props: BoundaryProps;
  state: BoundaryState;
  refs: Record<string, unknown> = {};
  updater?: ReactUpdaterLike;

  constructor(props: BoundaryProps, _context?: unknown, updater?: ReactUpdaterLike) {
    this.props = props;
    this.state = { error: null };
    this.updater = updater;
  }

  setState(partialState: Partial<BoundaryState>, callback?: () => void): void {
    this.updater?.enqueueSetState?.(this, partialState, callback, 'setState');
  }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(error);
    throw error;
  }

  render(): unknown {
    if (this.state.error !== null) {
      return null;
    }
    return this.props.children;
  }
}

(CrashlyticsErrorBoundary.prototype as unknown as { isReactComponent: Record<string, never> }).isReactComponent = {};

const inProcessDriver: CrashlyticsFrameworkDriver = {
  getCrashlytics,
  log,
  recordError,
};

function resolveLocationPathname(
  locationProp: Partial<CrashlyticsRouteLocation> | string | undefined,
): string {
  if (typeof locationProp === 'string' && locationProp.length > 0) {
    return locationProp;
  }
  if (
    typeof locationProp === 'object' &&
    locationProp !== null &&
    typeof locationProp.pathname === 'string' &&
    locationProp.pathname.length > 0
  ) {
    return locationProp.pathname;
  }
  return currentBrowserPathname();
}

/**
 * Wrapper replacement for `Routes` from `react-router-dom` that captures
 * route render errors and records navigation view-boundary breadcrumbs.
 */
export function CrashlyticsRoutes({
  firebaseApp,
  crashlyticsOptions,
  children,
  location,
}: ReactRouterCrashlyticsRoutesProps): CrashlyticsReactElement | null {
  const crashlytics = getCrashlytics(firebaseApp, crashlyticsOptions);
  const pathname = resolveLocationPathname(location);
  const matched = matchReactRouterChildren(children, pathname);

  emitViewBoundaryIfChanged(
    inProcessDriver,
    crashlytics,
    firebaseApp,
    matched.pattern,
    crashlyticsOptions,
  );

  if (matched.rendered === null || matched.rendered === undefined) {
    return null;
  }

  if (matched.elementSymbol !== undefined) {
    const boundaryElement = {
      $$typeof: matched.elementSymbol,
      type: CrashlyticsErrorBoundary,
      key: pathname,
      ref: null,
      props: {
        onError: (error: unknown) => {
          recordError(crashlytics, error);
        },
        children: matched.rendered,
      },
      _owner: null,
      _store: {},
    };
    return boundaryElement as unknown as CrashlyticsReactElement;
  }

  return matched.rendered as CrashlyticsReactElement;
}
