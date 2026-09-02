/**
 * Element anchoring. A pin is stored against the ELEMENT it was placed on — a
 * resolvable selector plus the click's fractional offset inside that element's
 * box — so it stays glued to the element through scrolling and layout shifts,
 * and an agent reading the comments later knows exactly what each one is about.
 *
 * The selector alone is a position (`div:nth-of-type(4)`), and in a wizard the
 * same position holds a different element on every step. So the element's own
 * identity (tag, ids, labels, text) is stored with it and checked on every
 * resolve: a lookalike at the same position does not get the pin, and an
 * element that moved is found again by that identity.
 */

export interface AnchorElementInfo {
  tag: string;
  id?: string;
  classes?: string[];
  testId?: string;
  ariaLabel?: string;
  role?: string;
  /** First ~80 chars of the element's visible text. */
  text?: string;
}

export interface Anchor {
  selector: string;
  /** Click position inside the element's box, as fractions of width/height. */
  ox: number;
  oy: number;
  element: AnchorElementInfo;
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

/** A selector that resolves the same element again: id, test id, or a tag path. */
export function buildSelector(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML' && parts.length < 12) {
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur?.tagName);
      const i = same.indexOf(cur) + 1;
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${i})` : tag);
      if (parent.id) {
        parts.unshift(`#${cssEscape(parent.id)}`);
        break;
      }
    } else {
      parts.unshift(tag);
    }
    cur = parent;
  }
  return parts.join(' > ');
}

function textOf(el: Element): string {
  return (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function describeElement(el: Element): AnchorElementInfo {
  const text = textOf(el);
  const classes = Array.from(el.classList).slice(0, 4);
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: classes.length ? classes : undefined,
    testId: el.getAttribute('data-testid') ?? undefined,
    ariaLabel: el.getAttribute('aria-label') ?? undefined,
    role: el.getAttribute('role') ?? undefined,
    text: text || undefined,
  };
}

/**
 * Whether `el` is the element the anchor describes. Text is the main signal:
 * exact for short labels ("Test Connection"), prefix for longer content, so a
 * counter changing inside a card ("Executions 17" → "18") does not lose its pin
 * but a different section at the same position does.
 */
export function matchesElement(el: Element, info: AnchorElementInfo): boolean {
  if (el.tagName.toLowerCase() !== info.tag) return false;
  if (info.id && el.id !== info.id) return false;
  if (info.testId && el.getAttribute('data-testid') !== info.testId) return false;
  if (info.ariaLabel && el.getAttribute('aria-label') !== info.ariaLabel) return false;
  if (info.role && el.getAttribute('role') !== info.role) return false;
  if (info.text === undefined) return true;
  const text = textOf(el);
  if (text === info.text) return true;
  if (info.text.length < 24 || text.length < 24) return false;
  return text.slice(0, 24) === info.text.slice(0, 24);
}

/** The anchor for an element, pinned at its centre. */
export function anchorFor(el: Element): Anchor {
  return { selector: buildSelector(el), ox: 0.5, oy: 0.5, element: describeElement(el) };
}

export type Box = { left: number; top: number; width: number; height: number };

/**
 * The elements a dragged box selects: every element at least 70% inside it,
 * reduced to the outermost ones (a selected card does not also select its
 * title and its buttons), skipping page-sized containers. Capped so a box
 * over a whole list does not become a comment on a hundred rows.
 */
export function anchorsInRect(doc: Document, box: Box, cap = 24): Anchor[] {
  return elementsInRect(doc, box, cap).map(anchorFor);
}

/** The elements `anchorsInRect` would anchor, for callers that need the nodes. */
export function elementsInRect(doc: Document, box: Box, cap = 24): Element[] {
  const win = doc.defaultView;
  if (!win) return [];
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  const inside: Element[] = [];
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.width > win.innerWidth * 0.9 && r.height > win.innerHeight * 0.9) continue;
    const ix = Math.max(0, Math.min(r.right, right) - Math.max(r.left, box.left));
    const iy = Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, box.top));
    if ((ix * iy) / (r.width * r.height) < 0.7) continue;
    inside.push(el);
  }
  const outer = inside.filter((el) => !inside.some((other) => other !== el && other.contains(el)));
  return outer.slice(0, cap);
}

/** Build the anchor for a click at viewport coordinates inside the iframe doc. */
export function anchorAt(doc: Document, x: number, y: number): Anchor | null {
  const el = doc.elementFromPoint(x, y);
  if (!el || el.tagName === 'HTML') return null;
  const r = el.getBoundingClientRect();
  return {
    selector: buildSelector(el),
    ox: r.width > 0 ? (x - r.left) / r.width : 0.5,
    oy: r.height > 0 ? (y - r.top) / r.height : 0.5,
    element: describeElement(el),
  };
}

/**
 * The anchored element on the current page, or null. The selector is tried
 * first; if it points at something else (a wizard step swapped the content at
 * that position) the page is searched for the one element that matches the
 * stored identity. Ambiguity means no pin rather than a guess.
 */
export function findAnchored(doc: Document, anchor: Anchor): Element | null {
  let el: Element | null = null;
  try {
    el = doc.querySelector(anchor.selector);
  } catch {
    el = null;
  }
  if (el && matchesElement(el, anchor.element)) return el;
  const info = anchor.element;
  if (!info.text && !info.id && !info.testId && !info.ariaLabel) return null;
  const candidates = Array.from(doc.querySelectorAll(info.tag)).filter((c) => matchesElement(c, info));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/** Where the anchored pin sits right now, in iframe-viewport coordinates. */
export function resolveAnchor(
  doc: Document,
  anchor: Anchor,
  cache: Map<string, { el: Element; checkedAt: number }>,
  key: string,
): { x: number; y: number } | null {
  const now = Date.now();
  let hit = cache.get(key);
  // React reuses DOM nodes across wizard steps, so a connected node can hold
  // different content than it did; re-check its identity every few frames.
  if (
    hit &&
    (!hit.el.isConnected || (now - hit.checkedAt > 250 && !matchesElement(hit.el, anchor.element)))
  ) {
    cache.delete(key);
    hit = undefined;
  }
  if (!hit) {
    const el = findAnchored(doc, anchor);
    if (!el) return null;
    hit = { el, checkedAt: now };
    cache.set(key, hit);
  } else if (now - hit.checkedAt > 250) {
    hit.checkedAt = now;
  }
  const r = hit.el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + anchor.ox * r.width, y: r.top + anchor.oy * r.height };
}
