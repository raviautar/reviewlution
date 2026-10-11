/**
 * reviewlution as a React component: the review toolbar drawn over the app it
 * is mounted in, no iframe and no proxy. The host app serves the comments API
 * (the routes in the README, "API for agents") under `apiBase`.
 *
 *   <ReviewToolbar apiBase="/__review/api" build="pr-12" author="Ravi" />
 *
 * In a router-driven app, pass `route` and `onNavigate` so route chips use the
 * router; without them the toolbar watches `location` and navigates with
 * `location.assign`. Nothing renders on the server: the toolbar reads the
 * page's DOM and the reviewer's local storage, so it appears after hydration.
 */
import { useEffect, useState } from 'react';
import { pageHost } from './host.js';
import { Toolbar } from './Toolbar.js';

export interface ReviewToolbarProps {
  /** Base of the comments API. Default `/__review/api`. */
  apiBase?: string;
  /** Build tag: sent on every comment created here, and the `?build=` scope of the lists. */
  build?: string;
  /** The reviewer's name when the app knows it; skips the name prompt. */
  author?: string | null;
  /** The current page, path plus query. Default: `location.pathname + location.search`, watched. */
  route?: string;
  /** Navigate to a comment's page. Default: `location.assign`. */
  onNavigate?: (path: string) => void;
  /** Accessible name of the toolbar's region. Default `reviewlution`. */
  title?: string;
}

function currentPath(): string {
  return location.pathname + location.search;
}

/** Follows `location` for hosts that pass no `route`: history moves and SPA pushes alike. */
function useLocationRoute(enabled: boolean): string {
  const [path, setPath] = useState(() => (typeof location === 'undefined' ? '/' : currentPath()));
  useEffect(() => {
    if (!enabled) return;
    const sync = () => setPath((cur) => (cur === currentPath() ? cur : currentPath()));
    sync();
    const tick = setInterval(sync, 600);
    window.addEventListener('popstate', sync);
    return () => {
      clearInterval(tick);
      window.removeEventListener('popstate', sync);
    };
  }, [enabled]);
  return path;
}

const assign = (path: string) => location.assign(path);

export function ReviewToolbar({ apiBase, build, author, route, onNavigate, title }: ReviewToolbarProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const watched = useLocationRoute(route === undefined);
  if (!mounted) return null;
  return (
    <Toolbar
      host={pageHost}
      apiBase={apiBase}
      build={build}
      author={author}
      route={route ?? watched}
      onNavigate={onNavigate ?? assign}
      title={title}
    />
  );
}

export type { ReviewComment, Reply, Viewport } from './api.js';
export type { Anchor, AnchorElementInfo } from './anchors.js';
