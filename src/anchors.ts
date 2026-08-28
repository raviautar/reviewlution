/**
 * Element anchoring. A pin is stored against the ELEMENT it was placed on — a
 * resolvable selector plus the click's fractional offset inside that element's
 * box — so it stays glued to the element through scrolling and layout shifts,
 * and an agent reading the comments later knows exactly what each one is about.
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

export function describeElement(el: Element): AnchorElementInfo {
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
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

/** Where the anchored pin sits right now, in iframe-viewport coordinates. */
export function resolveAnchor(
  doc: Document,
  anchor: Anchor,
  cache: Map<string, Element>,
  key: string,
): { x: number; y: number } | null {
  let el = cache.get(key);
  if (!el || !el.isConnected) {
    try {
      el = doc.querySelector(anchor.selector) ?? undefined;
    } catch {
      el = undefined;
    }
    if (!el) {
      cache.delete(key);
      return null;
    }
    cache.set(key, el);
  }
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + anchor.ox * r.width, y: r.top + anchor.oy * r.height };
}
