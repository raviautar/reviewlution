/**
 * The iframe shell: the app under review in a same-origin iframe (the server
 * proxies it), the toolbar (Toolbar.tsx) drawn over it, comments stored on
 * this host.
 *
 * The shell is URL-transparent: the server hands this page out for any document
 * navigation, the iframe loads the same path, and SPA navigation inside the
 * iframe is mirrored back with replaceState — the address bar never shows
 * /__review. The iframe is never remounted; the toolbar reads the app through
 * a Host that points at the frame's document and window.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Host } from './host.js';
import { Toolbar } from './Toolbar.js';

/** Server-injected settings (see server.mjs): where `/` lands, and the tab title. */
const CONFIG: { defaultRoute: string; title: string } = {
  defaultRoute: '/',
  title: 'Preview · reviewlution',
  ...((window as Window & { __REVIEW_TOOLBAR__?: Partial<{ defaultRoute: string; title: string }> }).__REVIEW_TOOLBAR__ ??
    {}),
};

/** The route this page was opened on; `/` and /__review itself fall back to the configured default. */
function initialRoute(): string {
  const path = location.pathname + location.search;
  if (path === '/' || path.startsWith('/__review')) return CONFIG.defaultRoute;
  return path;
}

export function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [route, setRoute] = useState(initialRoute);
  // The iframe's src is set once. Binding it to `route` would reload the studio
  // on every SPA navigation the poll below mirrors, wiping its in-page state.
  const [startRoute] = useState(initialRoute);
  const host = useMemo<Host>(
    () => ({
      doc: () => iframeRef.current?.contentDocument ?? null,
      win: () => iframeRef.current?.contentWindow ?? null,
    }),
    [],
  );

  // Mirror the iframe's SPA route onto the address bar.
  useEffect(() => {
    const tick = setInterval(() => {
      try {
        const loc = iframeRef.current?.contentWindow?.location;
        if (loc?.pathname) {
          const r = loc.pathname + loc.search;
          setRoute((cur) => (r === cur ? cur : r));
        }
      } catch {
        /* not ready yet */
      }
    }, 600);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    if (location.pathname + location.search !== route) history.replaceState(null, '', route);
  }, [route]);

  const navigate = useCallback((path: string) => {
    try {
      iframeRef.current?.contentWindow?.location.assign(path);
    } catch {
      /* navigation just won't happen */
    }
  }, []);

  return (
    <>
      <div style={{ position: 'fixed', inset: 0 }}>
        <iframe
          ref={iframeRef}
          src={startRoute}
          title={CONFIG.title}
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
        />
      </div>
      <Toolbar host={host} route={route} onNavigate={navigate} title={CONFIG.title} />
    </>
  );
}
