/**
 * REST client for the comment, image and video endpoints, and small shared
 * helpers. The endpoints live under one base (`/__review/api` by default); a
 * host that serves them elsewhere hands the toolbar its own `apiBase`, and the
 * components reach the client through ApiContext.
 */
import { createContext, useContext } from 'react';

export const ACCENT = '#5b2fcc';
// The toolbar was called review-toolbar until 2026-10-11; carry a reviewer's
// name, bubble position, draft and collapsed cards across the rename once.
// Server renders of a host page have no storage and skip it.
for (const [key, old] of typeof window === 'undefined' ? [] : [
  ['reviewlution-author', 'review-toolbar-author'],
  ['reviewlution-bubble-pos', 'review-toolbar-bubble-pos'],
  ['reviewlution-draft', 'review-toolbar-draft'],
  ['reviewlution-collapsed', 'review-toolbar-collapsed'],
]) {
  try {
    if (localStorage.getItem(key) === null) {
      const v = localStorage.getItem(old);
      if (v !== null) localStorage.setItem(key, v);
    }
  } catch {
    /* storage unavailable */
  }
}

export const AUTHOR_KEY = 'reviewlution-author';
export const POS_KEY = 'reviewlution-bubble-pos';
export const DRAFT_KEY = 'reviewlution-draft';
export const COLLAPSED_KEY = 'reviewlution-collapsed';
export const DEFAULT_API_BASE = '/__review/api';

export type { Reply, ReviewComment, Viewport } from './types.js';
import type { Viewport, ReviewComment } from './types.js';
import { reportError, reportedError } from './events.js';

// Chrome on Android freezes the UA's model to the literal "K"; the real one
// only comes from client hints, fetched once and remembered for later labels.
let hintedModel = '';
if (typeof window !== 'undefined') try {
  (navigator as { userAgentData?: { getHighEntropyValues?: (k: string[]) => Promise<{ model?: string }> } }).userAgentData
    ?.getHighEntropyValues?.(['model'])
    .then((d) => {
      hintedModel = d.model ?? '';
    })
    .catch(() => {});
} catch {
  /* no client hints */
}

/** "Samsung SM-G981B", "iPhone", "Mac": read from the UA the dev panel emulates. */
export function deviceLabel(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) {
    const android = /Android[^)]*;\s*([^);]+)\)/.exec(ua);
    let model = (android?.[1] ?? '').trim().replace(/\s+Build\/.*$/, '');
    if (!model || model === 'K') model = hintedModel;
    if (!model) return 'Android';
    return /^SM-/i.test(model) ? `Samsung ${model}` : model;
  }
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Desktop';
}

/** The device and size a comment was made at, measured on the app's window. */
export function captureViewport(win: Window): Viewport {
  const ua = navigator.userAgent;
  return { w: win.innerWidth, h: win.innerHeight, dpr: win.devicePixelRatio, ua, device: deviceLabel(ua) };
}

/**
 * The comments API at `base`. `build`, when set, scopes the lists to that
 * build (`?build=`); the server decides what an untagged comment counts as.
 * Every failed call is reported to the API's event log (events.ts) before it
 * throws.
 */
export function createApi(base: string = DEFAULT_API_BASE, build?: string) {
  const root = base.replace(/\/+$/, '');
  const API = `${root}/comments`;
  const scope = build ? `?build=${encodeURIComponent(build)}` : '';
  const JSON_HEADERS = { 'content-type': 'application/json' };

  /** `fetch`, reporting a network failure or a non-2xx answer; throws `failed (status)` on the latter. */
  async function call(failed: string, url: string, init: RequestInit = {}): Promise<Response> {
    const kind = /upload/i.test(failed) ? 'upload' : 'fetch';
    const context = { call: failed, method: init.method ?? 'GET', url };
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      reportError(kind, e, context);
      throw e;
    }
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    throw reportedError(kind, `${failed} failed (${res.status})`, { ...context, status: res.status, body: body.slice(0, 300) });
  }

  return {
    base: root,
    build,

    async addReply(commentId: string, text: string, author: string): Promise<void> {
      await call('Saving the reply', `${API}/${encodeURIComponent(commentId)}/replies`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ text, author }),
      });
    },

    async deleteReply(commentId: string, replyId: string): Promise<void> {
      await call('Deleting the reply', `${API}/${encodeURIComponent(commentId)}/replies/${encodeURIComponent(replyId)}`, {
        method: 'DELETE',
      });
    },

    async listComments(): Promise<ReviewComment[]> {
      return (await (await call('Loading comments', `${API}${scope}`)).json()) as ReviewComment[];
    },

    /** Deleted comments, newest first — recoverable from the Deleted tab. */
    async listDeleted(): Promise<ReviewComment[]> {
      return (await (await call('Loading deleted comments', `${root}/deleted${scope}`)).json()) as ReviewComment[];
    },

    async restoreComment(id: string): Promise<void> {
      await call('Restoring the comment', `${API}/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    },

    /** Saves the comment, tagged with this build when there is one. */
    async createComment(c: ReviewComment): Promise<void> {
      await call('Saving the comment', API, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(build ? { ...c, build } : c),
      });
    },

    async patchComment(id: string, updates: Partial<ReviewComment>): Promise<void> {
      await call('Updating the comment', `${API}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(updates),
      });
    },

    async deleteComment(id: string): Promise<void> {
      await call('Deleting the comment', `${API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    async uploadImage(file: File): Promise<string> {
      const res = await call('Uploading the image', `${root}/images`, {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      });
      return ((await res.json()) as { url: string }).url;
    },

    async uploadVideo(blob: Blob): Promise<string> {
      const res = await call('Uploading the recording', `${root}/videos`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'video/webm' },
        body: blob,
      });
      return ((await res.json()) as { url: string }).url;
    },
  };
}

export type Api = ReturnType<typeof createApi>;

export const ApiContext = createContext<Api>(createApi());

export function useApi(): Api {
  return useContext(ApiContext);
}

export function storedName(): string | null {
  try {
    return localStorage.getItem(AUTHOR_KEY);
  } catch {
    return null;
  }
}

/** Older comments carried the author as a trailing "— name" line; strip it. */
export function bodyOf(c: ReviewComment): string {
  if (!c.author) return c.text;
  const esc = c.author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return c.text.replace(new RegExp(`\\n— ${esc}$`), '');
}

export function timeAgo(at: number): string {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
