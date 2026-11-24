/**
 * Shared route-matching and view-boundary runtime for served
 * `firebase/crashlytics/{react,next-navigation,react-router,angular}` entries.
 */
import type { FirebaseApp } from 'pyric/app';
import type { Crashlytics, CrashlyticsOptions } from 'pyric/crashlytics';
import { getRawPath } from 'pyric/crashlytics/angular';

const APP_SCREEN_ID_ATTR = 'app.screen.id';
const VIEW_BOUNDARY_MESSAGE = 'Navigation event';

const servedBreadcrumbsByApp = new WeakSet<FirebaseApp>();
const servedLastPatternByApp = new WeakMap<FirebaseApp, string>();

function isBreadcrumbsPlugin(feature: unknown): boolean {
  if (typeof feature !== 'object' || feature === null) {
    return false;
  }
  const named = feature as { name?: unknown };
  if (named.name === 'breadcrumbs') {
    return true;
  }
  for (const sym of Object.getOwnPropertySymbols(feature)) {
    if (sym.description === 'pyric.crashlytics.breadcrumbs') {
      return true;
    }
  }
  return false;
}

export function rememberServedBreadcrumbs(
  app: FirebaseApp,
  options?: CrashlyticsOptions,
): boolean {
  if (Array.isArray(options?.features) && options.features.some(isBreadcrumbsPlugin)) {
    servedBreadcrumbsByApp.add(app);
  }
  return servedBreadcrumbsByApp.has(app);
}

export function emitServedViewBoundary(
  logFn: (
    crashlytics: Crashlytics,
    message: string,
    attributes?: Record<string, string>,
  ) => void,
  crashlytics: Crashlytics,
  app: FirebaseApp,
  pattern: string,
  options?: CrashlyticsOptions,
  forceLog = false,
): void {
  const enabled = rememberServedBreadcrumbs(app, options);
  const previous = servedLastPatternByApp.get(app);
  if (!forceLog && previous === pattern) {
    return;
  }
  servedLastPatternByApp.set(app, pattern);
  if (!enabled) {
    return;
  }
  logFn(crashlytics, VIEW_BOUNDARY_MESSAGE, {
    [APP_SCREEN_ID_ATTR]: pattern,
  });
}

export function currentServedPathname(): string {
  const win = (globalThis as { window?: { location?: { pathname?: unknown } } }).window;
  const raw = win?.location?.pathname;
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  return '/';
}

interface JsxElementLike {
  readonly $$typeof?: symbol;
  readonly type: unknown;
  readonly props?: Record<string, unknown>;
}

interface ParsedRouteNode {
  readonly path?: string;
  readonly index?: boolean;
  readonly element?: unknown;
  readonly children: ParsedRouteNode[];
}

function isJsxElementLike(value: unknown): value is JsxElementLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return 'type' in record && 'props' in record;
}

function findElementSymbol(value: unknown): symbol | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findElementSymbol(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isJsxElementLike(value)) {
    return undefined;
  }
  if (typeof value.$$typeof === 'symbol') {
    return value.$$typeof;
  }
  return findElementSymbol(value.props?.children);
}

const REACT_FRAGMENT_SYMBOL = Symbol.for('react.fragment');

function collectRoutes(children: unknown): {
  routes: ParsedRouteNode[];
  hasRouteElements: boolean;
} {
  const routes: ParsedRouteNode[] = [];
  let hasRouteElements = false;

  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (!isJsxElementLike(node)) {
      return;
    }
    if (node.type === REACT_FRAGMENT_SYMBOL) {
      visit(node.props?.children);
      return;
    }
    const props = node.props;
    if (
      typeof props !== 'object' ||
      props === null ||
      !('path' in props || 'index' in props || 'element' in props)
    ) {
      return;
    }
    hasRouteElements = true;
    const nested = collectRoutes(props.children);
    let routePath: string | undefined;
    if (typeof props.path === 'string') {
      routePath = props.path;
    }
    routes.push({
      path: routePath,
      index: props.index === true,
      element: props.element,
      children: nested.routes,
    });
  };

  visit(children);
  return { routes, hasRouteElements };
}

function splitSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(
  routeSegments: readonly string[],
  urlSegments: readonly string[],
  startIndex: number,
  allowPrefix: boolean,
): number | null {
  let urlIndex = startIndex;
  for (let i = 0; i < routeSegments.length; i += 1) {
    const routeSeg = routeSegments[i];
    if (routeSeg === '*') {
      return urlSegments.length;
    }
    if (urlIndex >= urlSegments.length) {
      return null;
    }
    const currentUrlSeg = urlSegments[urlIndex];
    if (routeSeg !== undefined && routeSeg.startsWith(':')) {
      urlIndex += 1;
      continue;
    }
    if (routeSeg !== currentUrlSeg) {
      return null;
    }
    urlIndex += 1;
  }
  if (!allowPrefix && urlIndex !== urlSegments.length) {
    return null;
  }
  return urlIndex;
}

function matchTree(
  routes: readonly ParsedRouteNode[],
  urlSegments: readonly string[],
  startIndex: number,
): { matchedPatterns: string[]; element: unknown } | null {
  for (const route of routes) {
    if (route.index === true) {
      if (startIndex === urlSegments.length) {
        return { matchedPatterns: [], element: route.element ?? null };
      }
      continue;
    }
    const rawPath = route.path ?? '';
    const routeSegments = rawPath === '/' ? [] : splitSegments(rawPath);
    const hasChildren = route.children.length > 0;
    const nextIndex = matchSegments(routeSegments, urlSegments, startIndex, hasChildren);
    if (nextIndex === null) {
      continue;
    }
    const ownPatterns: string[] = [];
    if (rawPath.length > 0 && rawPath !== '/') {
      const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
      if (trimmed.length > 0) {
        ownPatterns.push(trimmed);
      }
    }
    if (hasChildren) {
      const childMatch = matchTree(route.children, urlSegments, nextIndex);
      if (childMatch !== null) {
        let leaf = childMatch.element;
        if (leaf === null || leaf === undefined) {
          leaf = route.element ?? null;
        }
        return {
          matchedPatterns: [...ownPatterns, ...childMatch.matchedPatterns],
          element: leaf,
        };
      }
    }
    if (nextIndex === urlSegments.length) {
      return { matchedPatterns: ownPatterns, element: route.element ?? null };
    }
  }
  return null;
}

export function matchServedReactRouterChildren(
  children: unknown,
  pathname: string,
): { pattern: string; rendered: unknown; elementSymbol: symbol | undefined } {
  const cleanPathname = getRawPath(pathname);
  const elementSymbol = findElementSymbol(children);
  const { routes, hasRouteElements } = collectRoutes(children);
  if (!hasRouteElements) {
    let directRendered: unknown = null;
    if (children !== undefined && children !== null && typeof children !== 'boolean') {
      directRendered = children;
    }
    return { pattern: cleanPathname, rendered: directRendered, elementSymbol };
  }
  const match = matchTree(routes, splitSegments(cleanPathname), 0);
  if (match === null) {
    return { pattern: '/', rendered: null, elementSymbol };
  }
  const joined = match.matchedPatterns.join('/');
  const pattern = joined.length > 0 ? `/${joined}` : '/';
  const matchedSymbol = findElementSymbol(match.element) ?? elementSymbol;
  return { pattern, rendered: match.element ?? null, elementSymbol: matchedSymbol };
}
