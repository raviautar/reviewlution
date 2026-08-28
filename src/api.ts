/** REST client for the shell's comment + image endpoints, and small shared helpers. */
import type { Anchor } from './anchors.js';

export const ACCENT = '#5b2fcc';
export const AUTHOR_KEY = 'washi-review-author';
export const POS_KEY = 'washi-review-bubble-pos';
export const DRAFT_KEY = 'washi-review-draft';
const API = '/__review/api/comments';
const IMAGES_API = '/__review/api/images';

export interface ReviewComment {
  id: string;
  text: string;
  /** Legacy fallback position, percent of the viewport. */
  x: number;
  y: number;
  createdAt: number;
  color?: string;
  resolved?: boolean;
  author?: string;
  page?: string;
  images?: string[];
  /** Element anchoring — pins glue to the element, and agents get the context. */
  anchor?: Anchor;
}

export async function listComments(): Promise<ReviewComment[]> {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`Loading comments failed (${res.status})`);
  return (await res.json()) as ReviewComment[];
}

export async function createComment(c: ReviewComment): Promise<void> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(c),
  });
  if (!res.ok) throw new Error(`Saving the comment failed (${res.status})`);
}

export async function patchComment(id: string, updates: Partial<ReviewComment>): Promise<void> {
  const res = await fetch(`${API}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Updating the comment failed (${res.status})`);
}

export async function deleteComment(id: string): Promise<void> {
  const res = await fetch(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Deleting the comment failed (${res.status})`);
}

export async function uploadImage(file: File): Promise<string> {
  const res = await fetch(IMAGES_API, {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(`Uploading the image failed (${res.status})`);
  return ((await res.json()) as { url: string }).url;
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
