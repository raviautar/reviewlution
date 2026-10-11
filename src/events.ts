/**
 * The toolbar reports its own failures to the API (POST <apiBase>/events), so
 * a reviewer's failed save, upload, capture or crash can be debugged after the
 * fact. Only the toolbar's code reports here, never the host page's errors.
 *
 * A loop must not flood the log: the same failure is sent once a minute at
 * most, ten events a minute and fifty a page load in all, each trimmed small.
 * Reporting never throws and never reports its own failures.
 */
import type { Viewport } from './types.js';

export type EventKind = 'fetch' | 'upload' | 'record' | 'capture' | 'anchor' | 'crash' | 'toolbar';

/** Where reports go and what they say about the reviewer; the mounted Toolbar sets it. */
export interface Reporter {
  base: string;
  build?: string;
  route: () => string;
  author: () => string | null;
  url: () => string;
  viewport: () => Viewport | null;
}

const SAME_KEY_MS = 60_000;
const PER_MINUTE = 10;
const PER_PAGE_LOAD = 50;

let reporter: Reporter | null = null;
const lastSent = new Map<string, number>();
let minuteStart = 0;
let inMinute = 0;
let total = 0;
/** Errors already reported (by the API client), so a catch further up does not send them twice. */
const reported = new WeakSet<object>();

/** Point reports at a toolbar's API; returns the undo. */
export function setReporter(r: Reporter): () => void {
  reporter = r;
  return () => {
    if (reporter === r) reporter = null;
  };
}

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

function contextOf(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  try {
    const s = JSON.stringify(context);
    return s.length <= 1500 ? context : { truncated: s.slice(0, 1500) };
  } catch {
    return { unserializable: true };
  }
}

/** Report a failure in the toolbar's own code. Safe to call anywhere, any number of times. */
export function reportError(kind: EventKind, error: unknown, context?: Record<string, unknown>): void {
  try {
    const r = reporter;
    if (!r || typeof fetch === 'undefined') return;
    if (error && typeof error === 'object') {
      if (reported.has(error)) return;
      reported.add(error);
    }
    const message =
      error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error ?? 'unknown error');
    const key = `${kind}|${message}`;
    const now = Date.now();
    if (now - (lastSent.get(key) ?? -Infinity) < SAME_KEY_MS) return;
    if (now - minuteStart > 60_000) {
      minuteStart = now;
      inMinute = 0;
    }
    if (inMinute >= PER_MINUTE || total >= PER_PAGE_LOAD) return;
    lastSent.set(key, now);
    inMinute++;
    total++;
    const vp = r.viewport();
    const body = JSON.stringify({
      kind,
      message: clip(message, 500),
      stack: clip(error instanceof Error ? error.stack : undefined, 3000),
      route: r.route(),
      url: clip(r.url(), 1000),
      build: r.build,
      author: r.author() ?? undefined,
      viewport: vp ? { w: vp.w, h: vp.h, dpr: vp.dpr, device: vp.device } : undefined,
      userAgent: clip(navigator.userAgent, 300),
      context: contextOf(context),
    });
    // keepalive: a report made as the page unloads still goes. Its own failure is dropped.
    void fetch(`${r.base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* reporting must never break the toolbar */
  }
}

/** An error the caller throws on, reported first, so a catch further up does not report it again. */
export function reportedError(kind: EventKind, message: string, context?: Record<string, unknown>): Error {
  const e = new Error(message);
  reportError(kind, e, context);
  return e;
}
