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
  /** Element anchoring — pins glue to the element, and agents get the context. */
  anchor?: Anchor;
  /** Every element the comment is about, when there is more than one; `anchor` is the first. */
  anchors?: Anchor[];
  replies?: Reply[];
  /** Where the reviewer was looking from: emulated device and viewport size. */
  viewport?: Viewport;
  /** The build the comment was left on (e.g. `prod`, `pr-12`). None counts as `prod`. */
  build?: string;
}

export interface Viewport {
  w: number;
  h: number;
  dpr: number;
  ua: string;
  device: string;
}
