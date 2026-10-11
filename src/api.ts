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
 */
export function createApi(base: string = DEFAULT_API_BASE, build?: string) {
  const root = base.replace(/\/+$/, '');
  const API = `${root}/comments`;
  const scope = build ? `?build=${encodeURIComponent(build)}` : '';
  return {
    base: root,
    build,

    async addReply(commentId: string, text: string, author: string): Promise<void> {
      const res = await fetch(`${API}/${encodeURIComponent(commentId)}/replies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, author }),
      });
      if (!res.ok) throw new Error(`Saving the reply failed (${res.status})`);
    },

    async deleteReply(commentId: string, replyId: string): Promise<void> {
      const res = await fetch(
        `${API}/${encodeURIComponent(commentId)}/replies/${encodeURIComponent(replyId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`Deleting the reply failed (${res.status})`);
    },

    async listComments(): Promise<ReviewComment[]> {
      const res = await fetch(`${API}${scope}`);
      if (!res.ok) throw new Error(`Loading comments failed (${res.status})`);
      return (await res.json()) as ReviewComment[];
    },

    /** Deleted comments, newest first — recoverable from the Deleted tab. */
    async listDeleted(): Promise<ReviewComment[]> {
      const res = await fetch(`${root}/deleted${scope}`);
      if (!res.ok) throw new Error(`Loading deleted comments failed (${res.status})`);
      return (await res.json()) as ReviewComment[];
    },

    async restoreComment(id: string): Promise<void> {
      const res = await fetch(`${API}/${encodeURIComponent(id)}/restore`, { method: 'POST' });
      if (!res.ok) throw new Error(`Restoring the comment failed (${res.status})`);
    },

    /** Saves the comment, tagged with this build when there is one. */
    async createComment(c: ReviewComment): Promise<void> {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(build ? { ...c, build } : c),
      });
      if (!res.ok) throw new Error(`Saving the comment failed (${res.status})`);
    },

    async patchComment(id: string, updates: Partial<ReviewComment>): Promise<void> {
      const res = await fetch(`${API}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(`Updating the comment failed (${res.status})`);
    },

    async deleteComment(id: string): Promise<void> {
      const res = await fetch(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Deleting the comment failed (${res.status})`);
    },

    async uploadImage(file: File): Promise<string> {
      const res = await fetch(`${root}/images`, {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`Uploading the image failed (${res.status})`);
      return ((await res.json()) as { url: string }).url;
    },

    async uploadVideo(blob: Blob): Promise<string> {
      const res = await fetch(`${root}/videos`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'video/webm' },
        body: blob,
      });
      if (!res.ok) throw new Error(`Uploading the recording failed (${res.status})`);
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
