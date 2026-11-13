/**
 * The comment document, as the toolbar writes it and the API stores it. One
 * shape on both sides: the browser component and the server handler and
 * stores all import it from here.
 */
import type { Anchor } from './anchors.js';

/** A one-level reply; replies cannot be replied to. */
export interface Reply {
  id: string;
  text: string;
  author?: string;
  createdAt: number;
}

export interface ReviewComment {
  id: string;
  /** Set only on comments in the deleted store. */
  deletedAt?: number;
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
  /** Screen recordings attached to the comment. */
  videos?: string[];
  /**
   * The first element of `anchors`, where the pin sits. Kept for readers from
   * before `anchors`; read `anchors` for everything the comment is about.
   */
  anchor?: Anchor;
  /**
   * Every element the reviewer selected for the comment, in order: `[]` when it
   * is on no element. The API returns it on every comment (`anchorsOf`); the
   * toolbar saves it on every comment from 0.1.3, earlier ones only when there
   * was more than one element.
   */
  anchors?: Anchor[];
  replies?: Reply[];
  /** Where the reviewer was looking from: emulated device and viewport size. */
  viewport?: Viewport;
  /** The build the comment was left on (e.g. `prod`, `pr-12`). None counts as `prod`. */
  build?: string;
}

/**
 * Every element a comment is about, in order, `anchor` first. Reads comments
 * saved before 0.1.3 too, which carry `anchors` only when there was more than
 * one element, and a multi-element pin an older toolbar dragged, which got a
 * new `anchor` that `anchors` lacks: that element goes first and none is lost.
 */
export function anchorsOf(c: { anchor?: Anchor | null; anchors?: Anchor[] | null }): Anchor[] {
  const list = Array.isArray(c.anchors) ? c.anchors.filter((a) => !!a && typeof a === 'object') : [];
  const first = c.anchor && typeof c.anchor === 'object' ? c.anchor : null;
  return first ? [first, ...list.filter((a) => a.selector !== first.selector)] : list;
}

export interface Viewport {
  w: number;
  h: number;
  dpr: number;
  ua: string;
  device: string;
}
