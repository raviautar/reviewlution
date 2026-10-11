/**
 * reviewlution, the review toolbar: an element-anchored pin layer, the comment dialog, the
 * sidebar and the bubble, over whichever document a Host hands it. The iframe
 * shell (App.tsx) points it at its same-origin frame; the in-page component
 * (lib.tsx) at the document it is mounted in. Everything else is the same code.
 *
 * Pins belong to elements, not to scroll positions, so each frame their
 * positions are read from the anchored element's live bounding box. A pin
 * whose element is not on the current DOM simply has no dot — its comment
 * stays in the sidebar, which always lists every page's comments.
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect, type ErrorInfo, type ReactNode } from 'react';
import {
  ACCENT,
  ApiContext,
  AUTHOR_KEY,
  COLLAPSED_KEY,
  DRAFT_KEY,
  POS_KEY,
  bodyOf,
  captureViewport,
  createApi,
  storedName,
  timeAgo,
  useApi,
  type ReviewComment,
} from './api.js';
import {
  TOOLBAR_ATTR,
  anchorAt,
  anchorFor,
  elementsInRect,
  pageElementAt,
  resolveAnchor,
  type Anchor,
  type Box,
} from './anchors.js';
import { reportError, setReporter, type EventKind } from './events.js';
import { HostContext, useHost, type Host } from './host.js';
import { RecordButton } from './RecordButton.js';
import { SnapButton } from './SnapButton.js';
import { ChatIcon, CloseIcon, GripIcon, ImagePlusIcon, PencilIcon } from './icons.js';

type Mode = 'view' | 'annotate';
type Draft = { text: string; images: string[]; videos: string[] };
type Pending = {
  anchor: Anchor | null;
  /** Every selected element; `anchor` is the first, where the pending pin sits. */
  anchors: Anchor[];
  x: number;
  y: number;
  cx: number;
  cy: number;
  page: string;
};

const EMPTY_DRAFT: Draft = { text: '', images: [], videos: [] };

/** A handler of the toolbar's own whose throw is reported (events.ts) instead of escaping to the page. */
function guarded<A extends unknown[]>(kind: EventKind, fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch (e) {
      reportError(kind, e);
    }
  };
}
const FONT = "'Hanken Grotesk', system-ui, -apple-system, sans-serif";
/**
 * Hover colours for the borderless attachment buttons, and the browser
 * defaults a host page's base styles (a CSS reset, Tailwind's preflight) take
 * away, so the toolbar looks the same over any app. Unlayered, so it beats a
 * reset in a cascade layer; the inline styles still beat it.
 */
const TOOLBAR_CSS = `
[${TOOLBAR_ATTR}] :where(div, span, p, aside, form, a, img, video, h1) { box-sizing: content-box; }
[${TOOLBAR_ATTR}] :where(p) { margin: 1em 0; }
[${TOOLBAR_ATTR}] :where(h1) { font-weight: bold; }
[${TOOLBAR_ATTR}] :where(button) { font-size: 13.333px; line-height: normal; }
.rt-ibtn { background: transparent; color: #6b6880; }
.rt-ibtn:hover:not(:disabled) { background: #efedf7; color: #1b1926; }
`;
/** Outline colour for the element under the cursor — nothing in the studio's palette is this pink. */
const HIGHLIGHT = '#ff1fb3';

function storedDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY_DRAFT;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.text !== 'string' || !Array.isArray(d.images)) return EMPTY_DRAFT;
    return { text: d.text, images: d.images, videos: Array.isArray(d.videos) ? d.videos : [] };
  } catch {
    return EMPTY_DRAFT;
  }
}

function persistDraft(d: Draft) {
  try {
    if (!d.text && d.images.length === 0 && d.videos.length === 0) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* draft just won't survive a reload */
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  const tag = t.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t as HTMLElement).isContentEditable
  );
}

/* ---------------------------------------------------------------- pin layer */

type PinPos = { id: string; n: number; x: number; y: number; resolved: boolean; ghost: boolean };
/** Where a comment stands right now: its element is on this screen, gone from it
 * (the pin falls back to the original click spot), or on another page. */
type PinStatus = 'here' | 'missing' | 'elsewhere';

const anchorsOf = (c: ReviewComment): Anchor[] =>
  c.anchors?.length ? c.anchors : c.anchor ? [c.anchor] : [];

/** A short human name for an anchored element: its tag plus the text or label it carried. */
function anchorLabel(a: Anchor): string {
  const e = a.element;
  const name = (e.text || e.ariaLabel || e.testId || e.id || '').trim();
  const snip = name.length > 42 ? `${name.slice(0, 42)}…` : name;
  return snip ? `${e.tag} · “${snip}”` : e.tag;
}
type Outline = {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: string;
  label: string;
};

/** The element's own box, corner radius included, plus a short name for it. */
function outlineOf(el: Element): Outline | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  const snippet = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return {
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    radius: el.ownerDocument.defaultView?.getComputedStyle(el).borderRadius ?? '0px',
    label: `${el.tagName.toLowerCase()}${snippet ? ` · “${snippet}”` : ''} · ${Math.round(r.width)}×${Math.round(r.height)}`,
  };
}

/**
 * A pin sitting on a control the size of a button would take the click the
 * control is for, so on anything that short it hangs just above the control
 * (below it when there is no room), where the outline on hover still ties the
 * two together. A card or a panel keeps the pin at the exact spot: it covers a
 * corner of it, and the specific place is what the comment is about.
 */
const CONTROL_H = 56;
const CONTROLS = 'button, a, input, select, textarea, label, [role="button"], [role="tab"], [role="link"], [role="option"], [role="menuitem"]';
function clearOfControl(pos: { x: number; y: number }, el: Element): { x: number; y: number } {
  // A click lands on the label inside a button as often as on the button; the
  // control is what must stay clickable, so clear the whole of it.
  const r = (el.closest(CONTROLS) ?? el).getBoundingClientRect();
  if (r.height > CONTROL_H) return pos;
  return { x: pos.x, y: r.top >= 26 ? r.top - 13 : r.bottom + 13 };
}

function sameOutline(a: Outline | null, b: Outline | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height &&
    a.radius === b.radius &&
    a.label === b.label
  );
}

function PinLayer({
  comments,
  route,
  mode,
  pending,
  hoverId,
  onPlace,
  onAddAnchor,
  onPinClick,
  onMove,
  onStatuses,
}: {
  comments: ReviewComment[];
  route: string;
  mode: Mode;
  pending: Pending | null;
  hoverId: string | null;
  onPlace: (p: Pending) => void;
  /** Another element clicked or boxed while a comment is being written. */
  onAddAnchor: (a: Anchor) => void;
  onPinClick: (id: string) => void;
  /** A pin was dragged onto another element: its new anchor and fallback position. */
  onMove: (id: string, patch: Partial<ReviewComment>) => void;
  /** Per-comment placement status, sent whenever resolution changes. */
  onStatuses: (m: Map<string, PinStatus>) => void;
}) {
  const host = useHost();
  const [pins, setPins] = useState<PinPos[]>([]);
  const [pendingPos, setPendingPos] = useState<{ x: number; y: number } | null>(null);
  // Every selected element of the comment being written (or the one hovered in
  // the sidebar), outlined together; the rubber band while one is being dragged.
  const [multi, setMulti] = useState<Outline[]>([]);
  const [band, setBand] = useState<Box | null>(null);
  const bandRef = useRef<{ x: number; y: number; active: boolean } | null>(null);
  useEffect(() => {
    for (const k of Array.from(cache.current.keys())) if (k.startsWith('__pending')) cache.current.delete(k);
  }, [pending?.anchors]);
  const cache = useRef(new Map<string, { el: Element; checkedAt: number }>());
  const statusesRef = useRef('');
  const onStatusesRef = useRef(onStatuses);
  onStatusesRef.current = onStatuses;
  const hoverEl = useRef<Element | null>(null);
  const [outline, setOutline] = useState<Outline | null>(null);
  // Dragging a pin: pointer capture keeps the events on the pin even over the
  // app, so no window listeners are needed; a 4px threshold separates a
  // drag from a click, and Escape drops the pin back where it was.
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      dragRef.current = null;
      hoverEl.current = null;
      suppressClick.current = true;
      setDrag(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  // Positions are read from the live DOM every frame — this is what glues a
  // dot to its element through scrolling, layout shifts and SPA re-renders.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      try {
        place();
      } catch (e) {
        // Every frame would throw again; the reporter sends it once a minute.
        reportError('anchor', e, { during: 'pin placement' });
      }
    };
    const place = () => {
      const doc = host.doc();
      if (!doc) return;
      const next: PinPos[] = [];
      const statuses = new Map<string, PinStatus>();
      comments.forEach((c, i) => {
        const anchors = anchorsOf(c);
        let pos: { x: number; y: number } | null = null;
        for (const a of anchors) {
          // Keyed by selector too, so a pin moved to another element re-resolves.
          const key = `${c.id}|${a.selector}`;
          pos = resolveAnchor(doc, a, cache.current, key);
          if (pos) {
            const el = cache.current.get(key)?.el;
            if (el) pos = clearOfControl(pos, el);
            break;
          }
        }
        const onOwnPage = c.page === route;
        statuses.set(c.id, pos ? 'here' : onOwnPage ? (anchors.length ? 'missing' : 'here') : 'elsewhere');
        // Resolved comments live in the sidebar's Resolved tab, not on the page.
        if (c.resolved) return;
        // No element to glue to — gone from this build, or a pre-anchor comment.
        // On the comment's own page the pin falls back to the original click
        // spot, drawn as a ghost when an anchor should have matched.
        let ghost = false;
        if (!pos && onOwnPage) {
          pos = { x: (c.x / 100) * window.innerWidth, y: (c.y / 100) * window.innerHeight };
          ghost = anchors.length > 0;
        }
        if (!pos) return;
        if (pos.y < -20 || pos.y > window.innerHeight + 20) return;
        next.push({ id: c.id, n: i + 1, x: pos.x, y: pos.y, resolved: !!c.resolved, ghost });
      });
      const ser = Array.from(statuses, ([k, v]) => `${k}:${v}`).join('|');
      if (ser !== statusesRef.current) {
        statusesRef.current = ser;
        onStatusesRef.current(new Map(statuses));
      }
      setPins((cur) => {
        if (
          cur.length === next.length &&
          cur.every((p, i) => {
            const q = next[i];
            return (
              q &&
              p.id === q.id &&
              Math.abs(p.x - q.x) < 0.5 &&
              Math.abs(p.y - q.y) < 0.5 &&
              p.resolved === q.resolved &&
              p.ghost === q.ghost
            );
          })
        ) {
          return cur;
        }
        return next;
      });
      if (pending) {
        const pos = pending.anchor
          ? (() => {
              const at = resolveAnchor(doc, pending.anchor, cache.current, '__pending');
              const el = cache.current.get('__pending')?.el;
              return at && el ? clearOfControl(at, el) : at;
            })()
          : { x: (pending.x / 100) * window.innerWidth, y: (pending.y / 100) * window.innerHeight };
        setPendingPos((cur) =>
          pos && (!cur || Math.abs(cur.x - pos.x) > 0.5 || Math.abs(cur.y - pos.y) > 0.5)
            ? pos
            : pos
              ? cur
              : null,
        );
      } else {
        setPendingPos(null);
      }
      // While a pin is being written the outline stays on its element; while one
      // is being dragged, or in annotate mode, it follows the cursor. Measured
      // every frame so it rides along on scroll.
      const target = drag
        ? hoverEl.current
        : mode !== 'annotate'
          ? null
          : hoverEl.current;
      const nextOutline = target?.isConnected ? outlineOf(target) : null;
      const group: { a: Anchor; key: string }[] = pending
        ? pending.anchors.map((a, i) => ({ a, key: `__pending|${i}` }))
        : (() => {
            const c = hoverId ? comments.find((x) => x.id === hoverId) : undefined;
            return (c?.anchors ?? []).map((a, i) => ({ a, key: `${c?.id}|multi|${i}` }));
          })();
      const sel: Outline[] = [];
      for (const { a, key } of group) {
        resolveAnchor(doc, a, cache.current, key);
        const el = cache.current.get(key)?.el;
        const o = el?.isConnected ? outlineOf(el) : null;
        if (o) sel.push(o);
      }
      setMulti((cur) => (cur.length === sel.length && cur.every((o, i) => sameOutline(o, sel[i] ?? null)) ? cur : sel));
      if (drag && nextOutline) nextOutline.label = `Move here: ${nextOutline.label}`;
      setOutline((cur) => (sameOutline(cur, nextOutline) ? cur : nextOutline));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [host, comments, route, pending, mode, drag]);

  const pinPointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer — no capture available, the drag still works over the pin */
    }
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, moved: false };
  };
  const pinPointerMove = (e: React.PointerEvent, id: string) => {
    const d = dragRef.current;
    if (!d || d.id !== id) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
      d.moved = true;
    }
    const doc = host.doc();
    const el = doc ? pageElementAt(doc, e.clientX, e.clientY) : null;
    hoverEl.current = el && el.tagName !== 'HTML' && el.tagName !== 'BODY' ? el : null;
    setDrag({ id, x: e.clientX, y: e.clientY });
  };
  const pinPointerUp = guarded('anchor', (e: React.PointerEvent, id: string) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !d.moved) return;
    suppressClick.current = true;
    hoverEl.current = null;
    setDrag(null);
    const doc = host.doc();
    const anchor = doc ? anchorAt(doc, e.clientX, e.clientY) : null;
    if (!anchor) return;
    onMove(id, {
      anchor,
      x: (e.clientX / window.innerWidth) * 100,
      y: (e.clientY / window.innerHeight) * 100,
      page: route,
    });
  });

  const track = (e: React.MouseEvent) => {
    const doc = host.doc();
    const el = doc ? pageElementAt(doc, e.clientX, e.clientY) : null;
    hoverEl.current = el && el.tagName !== 'HTML' && el.tagName !== 'BODY' ? el : null;
  };

  // The overlay swallows the wheel, so hand it to the scrollable ancestor under
  // the cursor — otherwise nothing below the fold can be commented on. Drawn
  // over the page itself the overlay would also scroll the document natively,
  // so the listener is non-passive and the browser's own scroll is cancelled.
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || mode !== 'annotate') return;
    const forwardWheel = (e: WheelEvent) => {
      const doc = host.doc();
      const win = doc?.defaultView;
      if (!doc || !win) return;
      e.preventDefault();
      let el: Element | null = pageElementAt(doc, e.clientX, e.clientY);
      while (el) {
        const cs = win.getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) break;
        el = el.parentElement;
      }
      (el ?? doc.scrollingElement ?? doc.documentElement).scrollBy(e.deltaX, e.deltaY);
    };
    overlay.addEventListener('wheel', forwardWheel, { passive: false });
    return () => overlay.removeEventListener('wheel', forwardWheel);
  }, [host, mode]);

  // A press that moves is a rubber band over the page; one that does not is a
  // click. Either adds to the comment being written, or starts one.
  const bandDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    bandRef.current = { x: e.clientX, y: e.clientY, active: false };
  };
  const bandMove = (e: React.PointerEvent) => {
    const b = bandRef.current;
    if (!b) return;
    if (!b.active) {
      if (Math.hypot(e.clientX - b.x, e.clientY - b.y) < 6) return;
      b.active = true;
    }
    setBand({
      left: Math.min(b.x, e.clientX),
      top: Math.min(b.y, e.clientY),
      width: Math.abs(e.clientX - b.x),
      height: Math.abs(e.clientY - b.y),
    });
  };
  const bandUp = guarded('anchor', (e: React.PointerEvent) => {
    const b = bandRef.current;
    bandRef.current = null;
    const doc = host.doc();
    if (!b || !doc) return;
    const at = {
      x: (e.clientX / window.innerWidth) * 100,
      y: (e.clientY / window.innerHeight) * 100,
      cx: e.clientX,
      cy: e.clientY,
      page: route,
    };
    if (b.active) {
      const box = {
        left: Math.min(b.x, e.clientX),
        top: Math.min(b.y, e.clientY),
        width: Math.abs(e.clientX - b.x),
        height: Math.abs(e.clientY - b.y),
      };
      setBand(null);
      const found = elementsInRect(doc, box);
      if (found.length === 0) return;
      if (pending) {
        // A box absorbs what it encloses: a pill selected earlier joins its
        // card rather than sitting beside it, and a card already selected
        // does not gain its own children.
        const have = pending.anchors.map((a, i) => ({ a, el: cache.current.get(`__pending|${i}`)?.el }));
        for (const h of have) {
          const hel = h.el;
          if (hel && found.some((el) => el !== hel && el.contains(hel))) onAddAnchor(h.a);
        }
        for (const el of found) {
          if (have.some((h) => h.el && (h.el === el || h.el.contains(el)))) continue;
          onAddAnchor(anchorFor(el));
        }
        return;
      }
      cache.current.delete('__pending');
      const anchors = found.map(anchorFor);
      onPlace({ anchor: anchors[0] ?? null, anchors, ...at });
      return;
    }
    const a = anchorAt(doc, e.clientX, e.clientY);
    if (pending) {
      if (a) onAddAnchor(a);
      return;
    }
    cache.current.delete('__pending');
    onPlace({ anchor: a, anchors: a ? [a] : [], ...at });
  });

  return (
    <div
      onPointerDown={mode === 'annotate' ? bandDown : undefined}
      onPointerMove={mode === 'annotate' ? bandMove : undefined}
      onPointerUp={mode === 'annotate' ? bandUp : undefined}
      onMouseMove={mode === 'annotate' ? track : undefined}
      onMouseLeave={() => {
        hoverEl.current = null;
      }}
      ref={overlayRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147482800,
        pointerEvents: mode === 'annotate' ? 'auto' : 'none',
        cursor: mode === 'annotate' ? 'crosshair' : undefined,
      }}
    >
      {multi.map((o, i) => (
        <div
          key={`${o.left}|${o.top}|${i}`}
          style={{
            position: 'absolute',
            left: o.left,
            top: o.top,
            width: o.width,
            height: o.height,
            boxSizing: 'border-box',
            borderRadius: o.radius,
            border: `1.5px solid ${HIGHLIGHT}a6`,
            background: `${HIGHLIGHT}0a`,
            pointerEvents: 'none',
          }}
        />
      ))}
      {band && (
        <div
          style={{
            position: 'absolute',
            left: band.left,
            top: band.top,
            width: band.width,
            height: band.height,
            boxSizing: 'border-box',
            border: `1px dashed ${HIGHLIGHT}b3`,
            background: `${HIGHLIGHT}12`,
            borderRadius: 4,
            pointerEvents: 'none',
          }}
        />
      )}
      {outline && (
        <>
          <div
            style={{
              position: 'absolute',
              left: outline.left,
              top: outline.top,
              width: outline.width,
              height: outline.height,
              boxSizing: 'border-box',
              borderRadius: outline.radius,
              border: `1.5px solid ${HIGHLIGHT}`,
              boxShadow: `0 0 0 2px ${HIGHLIGHT}22`,
              pointerEvents: 'none',
              transition: 'left .05s linear, top .05s linear, width .05s linear, height .05s linear',
            }}
          />
          <span
            style={{
              position: 'absolute',
              left: Math.max(4, Math.min(outline.left, window.innerWidth - 330)),
              top: outline.top >= 26 ? outline.top - 24 : outline.top + outline.height + 4,
              maxWidth: 320,
              padding: '2px 8px',
              borderRadius: 6,
              background: HIGHLIGHT,
              color: '#fff',
              font: '600 11px/16px system-ui, sans-serif',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              pointerEvents: 'none',
              boxShadow: '0 2px 8px -2px rgba(20,20,30,.4)',
            }}
          >
            {outline.label}
          </span>
        </>
      )}
      {pins.map((p) => {
        const dragging = drag?.id === p.id;
        const x = dragging ? drag.x : p.x;
        const y = dragging ? drag.y : p.y;
        return (
          <button
            key={p.id}
            type="button"
            title={
              p.ghost
                ? "The element this comment points at isn't on this screen — the pin marks its original spot. Drag it onto the right element to re-attach it."
                : 'Open this comment · drag it onto another element to move it'
            }
            onPointerDown={(e) => pinPointerDown(e, p.id)}
            onPointerMove={(e) => pinPointerMove(e, p.id)}
            onPointerUp={(e) => pinPointerUp(e, p.id)}
            onPointerCancel={() => {
              dragRef.current = null;
              hoverEl.current = null;
              setDrag(null);
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              onPinClick(p.id);
            }}
            style={{
              position: 'absolute',
              left: x - 11,
              top: y - 11,
              width: 22,
              height: 22,
              borderRadius: '50% 50% 50% 4px',
              border: `2px ${p.ghost ? 'dashed' : 'solid'} ${dragging ? HIGHLIGHT : '#fff'}`,
              background: p.ghost ? '#8a879a' : ACCENT,
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: dragging ? 'grabbing' : 'pointer',
              pointerEvents: 'auto',
              touchAction: 'none',
              padding: 0,
              opacity: p.resolved ? 0.45 : p.ghost ? 0.85 : 1,
              transform: dragging ? 'scale(1.2)' : undefined,
              zIndex: dragging ? 1 : undefined,
              boxShadow: dragging
                ? `0 0 0 4px ${HIGHLIGHT}44, 0 8px 18px -6px rgba(20,20,30,.6)`
                : hoverId === p.id
                  ? `0 0 0 3px ${ACCENT}55, 0 4px 10px -4px rgba(20,20,30,.5)`
                  : '0 4px 10px -4px rgba(20,20,30,.5)',
            }}
          >
            {p.n}
          </button>
        );
      })}
      {pendingPos && (
        <span
          style={{
            position: 'absolute',
            left: pendingPos.x - 11,
            top: pendingPos.y - 11,
            width: 22,
            height: 22,
            borderRadius: '50% 50% 50% 4px',
            border: '2px dashed #fff',
            background: `${ACCENT}cc`,
            boxShadow: '0 4px 10px -4px rgba(20,20,30,.5)',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- the bubble */

type Pos = { x: number; y: number };

function storedPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pos;
    return typeof p.x === 'number' && typeof p.y === 'number' ? p : null;
  } catch {
    return null;
  }
}

function clampPos(p: Pos, w: number, h: number): Pos {
  return {
    x: Math.min(Math.max(p.x, 8), Math.max(8, window.innerWidth - w - 8)),
    y: Math.min(Math.max(p.y, 8), Math.max(8, window.innerHeight - h - 8)),
  };
}

const bubbleBtn = {
  border: 'none',
  background: 'transparent',
  color: '#4a4760',
  width: 32,
  height: 32,
  borderRadius: 16,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flex: 'none',
  position: 'relative',
} as const;

/** Minimal white toolbar: grip, reviewer name, pencil toggle, comment count. */
function Bubble({
  author,
  mode,
  count,
  sidebarOpen,
  onToggleMode,
  onChangeName,
  onToggleSidebar,
}: {
  author: string | null;
  mode: Mode;
  count: number;
  sidebarOpen: boolean;
  onToggleMode: () => void;
  onChangeName: () => void;
  onToggleSidebar: () => void;
}) {
  const [pos, setPos] = useState<Pos | null>(storedPos);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const annotate = mode === 'annotate';
  // A position saved on a wide window can sit past the edge of a narrow one, so
  // the saved spot is clamped to the window as it is now, on every resize.
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const size = ref.current?.getBoundingClientRect();
  const shown = pos ? clampPos(pos, size?.width ?? 160, size?.height ?? 42) : null;

  const onGripDown = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      /* window-level move events still land on the grip while pressed */
    }
  };
  const onGripMove = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!drag.current || !el) return;
    const r = el.getBoundingClientRect();
    setPos(
      clampPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }, r.width, r.height),
    );
  };
  const onGripUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setPos((p) => {
      if (p) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(p));
        } catch {
          /* position just won't persist */
        }
      }
      return p;
    });
  };

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        ...(shown ? { left: shown.x, top: shown.y } : { right: 18, bottom: 18 }),
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: 4,
        borderRadius: 21,
        background: '#fff',
        border: '1px solid #e5e3ee',
        boxShadow: '0 10px 30px -12px rgba(20,20,30,.35)',
        zIndex: 2147483000,
        userSelect: 'none',
      }}
    >
      <span
        role="button"
        aria-label="Drag to move"
        title="Drag to move"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        style={{
          width: 20,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#b6b3c4',
          cursor: 'grab',
          touchAction: 'none',
        }}
      >
        <GripIcon />
      </span>
      {author && (
        <button
          type="button"
          onClick={onChangeName}
          title="Change your reviewer name"
          style={{
            ...bubbleBtn,
            width: 'auto',
            padding: '0 10px',
            fontSize: 12,
            fontWeight: 600,
            color: '#6b6880',
          }}
        >
          {author}
        </button>
      )}
      <button
        type="button"
        title={annotate ? 'Stop commenting (⌥C)' : 'Comment: click any element (⌥C)'}
        aria-label={annotate ? 'Exit annotate mode' : 'Enter annotate mode'}
        onClick={onToggleMode}
        style={{
          ...bubbleBtn,
          background: annotate ? ACCENT : 'transparent',
          color: annotate ? '#fff' : '#4a4760',
        }}
      >
        <PencilIcon />
      </button>
      <button
        type="button"
        title="All comments (⌥L)"
        aria-label="Toggle comments sidebar"
        onClick={onToggleSidebar}
        style={{ ...bubbleBtn, background: sidebarOpen ? '#efedf7' : 'transparent' }}
      >
        <ChatIcon />
        {count > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -3,
              right: -3,
              minWidth: 15,
              height: 15,
              borderRadius: 8,
              background: ACCENT,
              color: '#fff',
              fontSize: 9.5,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 3px',
            }}
          >
            {count}
          </span>
        )}
      </button>
    </div>
  );
}

/* ------------------------------------------------------- the create dialog */

function CreateDialog({
  pending,
  draft,
  onDraft,
  onSubmit,
  onClose,
  onCapture,
  onRemoveAnchor,
}: {
  pending: Pending;
  draft: Draft;
  onDraft: (d: Draft) => void;
  onSubmit: () => Promise<void>;
  onClose: () => void;
  /** True while an area is picked, captured or recorded, so the shell steps aside. */
  onCapture: (busy: boolean) => void;
  /** Drop one element from the selection. */
  onRemoveAnchor: (i: number) => void;
}) {
  const { uploadImage } = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canSubmit = !!draft.text.trim() || draft.images.length > 0 || draft.videos.length > 0;
  const [recording, setRecording] = useState(false);
  const capture = (b: boolean) => {
    setRecording(b);
    onCapture(b);
  };

  const addFiles = async (files: Iterable<File>) => {
    setError(null);
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      setBusy(true);
      try {
        const url = await uploadImage(f);
        onDraft({ ...draft, images: [...draft.images, url] });
      } catch (e) {
        reportError('upload', e, { during: 'attach image' });
        setError(e instanceof Error ? e.message : 'Image upload failed');
      } finally {
        setBusy(false);
      }
    }
  };

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (e) {
      reportError('toolbar', e, { during: 'save comment' });
      setError(e instanceof Error ? e.message : 'Saving failed');
    } finally {
      setBusy(false);
    }
  };

  const left = Math.min(Math.max(pending.cx, 12), window.innerWidth - 332);
  const wanted = Math.min(Math.max(pending.cy + 14, 12), window.innerHeight - 320);
  // The box grows with its selection and attachments, so it is measured after
  // layout and pushed up until its bottom edge is back on screen.
  const boxRef = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const over = el.getBoundingClientRect().height + wanted - (window.innerHeight - 12);
    setLift(over > 0 ? Math.min(over, wanted - 12) : 0);
  }, [wanted, pending.anchors.length, draft.images.length, draft.videos.length, error]);
  const top = wanted - lift;

  return (
    <div
      ref={boxRef}
      style={{
        position: 'fixed',
        left,
        top,
        width: 320,
        boxSizing: 'border-box',
        background: '#fff',
        border: '1px solid #e3e1ec',
        borderRadius: 14,
        boxShadow: '0 18px 50px -18px rgba(20,20,30,.4)',
        padding: '12px 14px',
        zIndex: 2147483050,
        // Out of the way while an area is picked or recorded, so it is not in the clip.
        visibility: recording ? 'hidden' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 12.5, color: '#1b1926' }}>Add comment</b>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close (your draft is kept)"
          title="Close — your draft is kept"
          style={{
            marginLeft: 'auto',
            border: 'none',
            background: 'transparent',
            color: '#8a879a',
            cursor: 'pointer',
            padding: 2,
          }}
        >
          <CloseIcon size={13} />
        </button>
      </div>
      {pending.anchors.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            marginBottom: 8,
            maxHeight: 118,
            overflowY: 'auto',
            paddingRight: 2,
          }}
        >
          <span style={{ width: '100%', fontSize: 11, color: '#8a879a', marginBottom: 2 }}>
            {pending.anchors.length === 1 ? '1 element' : `${pending.anchors.length} elements`} · click
            more or drag a box to add
          </span>
          {pending.anchors.map((a, i) => (
            <span
              key={`${a.selector}|${i}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                maxWidth: '100%',
                padding: '2px 4px 2px 7px',
                borderRadius: 7,
                background: `${HIGHLIGHT}14`,
                border: `1px solid ${HIGHLIGHT}55`,
                color: '#1b1926',
                fontSize: 11,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.element.tag}
                {a.element.text ? ` · “${a.element.text.slice(0, 18)}${a.element.text.length > 18 ? '…' : ''}”` : ''}
              </span>
              <button
                type="button"
                onClick={() => onRemoveAnchor(i)}
                aria-label="Remove this element from the comment"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: '#8a879a',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'inline-flex',
                }}
              >
                <CloseIcon size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        autoFocus
        value={draft.text}
        onChange={(e) => onDraft({ ...draft, text: e.target.value })}
        onPaste={(e) => {
          if (e.clipboardData.files.length > 0) {
            e.preventDefault();
            void addFiles(e.clipboardData.files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Leave a comment… (paste screenshots here)"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          height: 74,
          resize: 'vertical',
          border: '1px solid #dcdae6',
          borderRadius: 10,
          padding: '8px 10px',
          fontSize: 13,
          fontFamily: 'inherit',
        }}
      />
      {draft.images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {draft.images.map((url) => (
            <span key={url} style={{ position: 'relative' }}>
              <img
                src={url}
                alt=""
                style={{
                  width: 64,
                  height: 48,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid #e3e1ec',
                  display: 'block',
                }}
              />
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => onDraft({ ...draft, images: draft.images.filter((u) => u !== url) })}
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  width: 17,
                  height: 17,
                  borderRadius: 9,
                  border: 'none',
                  background: '#1b1926',
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
              >
                <CloseIcon size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
      {draft.videos.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {draft.videos.map((url) => (
            <span key={url} style={{ position: 'relative' }}>
              <video src={url} controls preload="metadata" style={clipStyle} />
              <button
                type="button"
                aria-label="Remove recording"
                onClick={() => onDraft({ ...draft, videos: draft.videos.filter((u) => u !== url) })}
                style={removeBtn}
              >
                <CloseIcon size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <p style={{ margin: '8px 0 0', fontSize: 12, color: '#b3261e' }}>{error}</p>}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          marginTop: 8,
          marginLeft: -6,
          flexWrap: 'wrap',
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <SnapButton
          onDone={(url) => onDraft({ ...draft, images: [...draft.images, url] })}
          onBusy={capture}
          style={attachBtn}
          className="rt-ibtn"
          iconSize={15}
        />
        <RecordButton
          onDone={(url) => onDraft({ ...draft, videos: [...draft.videos, url] })}
          onBusy={capture}
          style={attachBtn}
          className="rt-ibtn"
          iconSize={15}
        />
        <button
          type="button"
          className="rt-ibtn"
          onClick={() => fileInput.current?.click()}
          title="Add images from your computer"
          aria-label="Add images"
          style={attachBtn}
        >
          <ImagePlusIcon size={15} />
        </button>
        <button
          type="button"
          disabled={busy || !canSubmit}
          onClick={() => void submit()}
          style={{
            marginLeft: 'auto',
            border: 'none',
            background: busy || !canSubmit ? '#c9c3dd' : ACCENT,
            color: '#fff',
            borderRadius: 9,
            height: 30,
            padding: '0 14px',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Saving…' : 'Add'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the sidebar */

function storedCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistCollapsed(ids: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    /* the fold state just won't survive a reload */
  }
}

function Sidebar({
  me,
  route,
  comments,
  focusId,
  onHover,
  onOpenComment,
  onEdit,
  onResolve,
  onDelete,
  onReply,
  onDeleteReply,
  onClearResolved,
  onClose,
  hidden,
  onCapture,
  statuses,
  deleted,
  onRestore,
}: {
  /** Kept mounted but invisible while a capture runs from one of its cards. */
  hidden: boolean;
  onCapture: (busy: boolean) => void;
  /** Placement status per comment id, from the pin layer. */
  statuses: Map<string, PinStatus>;
  /** Deleted comments, newest first — the Deleted tab restores from here. */
  deleted: ReviewComment[];
  onRestore: (c: ReviewComment) => void;
  me: string;
  route: string;
  comments: ReviewComment[];
  focusId: string | null;
  onHover: (id: string | null) => void;
  onOpenComment: (c: ReviewComment) => void;
  onEdit: (c: ReviewComment, patch: { text: string; images?: string[]; videos?: string[] }) => void;
  onResolve: (c: ReviewComment) => void;
  onDelete: (c: ReviewComment) => void;
  onReply: (c: ReviewComment, text: string) => Promise<void>;
  onDeleteReply: (c: ReviewComment, replyId: string) => void;
  onClearResolved: () => void;
  onClose: () => void;
}) {
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [tab, setTab] = useState<'open' | 'resolved' | 'deleted'>('open');
  const [confirmClear, setConfirmClear] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(storedCollapsed);
  // One reply box open at a time; it starts as a button on the card.
  const [replyingId, setReplyingId] = useState<string | null>(null);

  const setFold = (ids: Set<string>) => {
    persistCollapsed(ids);
    setCollapsed(ids);
  };
  const toggleFold = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFold(next);
  };

  // Numbering stays global (matches the pins); the tabs only filter the view.
  const numbered = comments.map((c, i) => ({ c, n: i + 1 }));
  const shown = numbered.filter(({ c }) => (tab === 'resolved' ? c.resolved : !c.resolved));
  const openCount = numbered.length - numbered.filter(({ c }) => c.resolved).length;
  const allFolded = shown.length > 0 && shown.every(({ c }) => collapsed.has(c.id));

  useEffect(() => {
    if (!focusId) return;
    const target = comments.find((c) => c.id === focusId);
    if (target?.resolved) setTab('resolved');
    // Opening a comment from its pin always shows it in full.
    setCollapsed((cur) => {
      if (!cur.has(focusId)) return cur;
      const next = new Set(cur);
      next.delete(focusId);
      persistCollapsed(next);
      return next;
    });
    cardRefs.current.get(focusId)?.scrollIntoView({ block: 'center' });
  }, [focusId, comments]);

  const { base: apiBase } = useApi();
  const [copiedTick, setCopiedTick] = useState(false);
  const copyShown = () => {
    const origin = location.origin;
    const abs = (u: string) => (u.startsWith('http') ? u : `${origin}${u}`);
    const lines = shown.map(({ c, n }) => {
      const status = c.resolved ? 'resolved' : 'open';
      const head = `### #${n} · ${c.page ?? '/'} · ${status}${c.author ? ` · ${c.author}` : ''}`;
      const replies = (c.replies ?? []).map((r) => `> ${r.author ?? 'reply'}: ${r.text}`);
      const media = [
        ...(c.images ?? []).map((u) => `image: ${abs(u)}`),
        ...(c.videos ?? []).map((u) => `video: ${abs(u)}`),
      ];
      // Where the pin sits, in terms an agent can find in the codebase.
      const where: string[] = [];
      const anchors = c.anchors?.length ? c.anchors : c.anchor ? [c.anchor] : [];
      for (const [i, a] of anchors.entries()) {
        const el = a.element;
        const nth = anchors.length > 1 ? ` ${i + 1}/${anchors.length}` : '';
        const idy = [
          `${el.tag}${el.id ? `#${el.id}` : ''}${el.classes?.length ? `.${el.classes.join('.')}` : ''}`,
          el.testId ? `[data-testid="${el.testId}"]` : '',
          el.role ? `[role="${el.role}"]` : '',
          el.ariaLabel ? `[aria-label="${el.ariaLabel}"]` : '',
          el.text ? `· "${el.text}"` : '',
        ]
          .filter(Boolean)
          .join(' ');
        where.push(`element${nth}: ${idy}`, `selector${nth}: ${a.selector}`);
      }
      if (anchors.length === 0) {
        where.push(`position: ${Math.round(c.x)}%,${Math.round(c.y)}% of the viewport (no element anchor)`);
      }
      if (c.viewport) where.push(`viewport: ${c.viewport.device} · ${c.viewport.w}×${c.viewport.h} @${c.viewport.dpr}x`);
      where.push(`from: ${origin}${c.page ?? '/'}`, `comment id: ${c.id} (API: ${origin}${apiBase}/comments/${c.id})`);
      return [head, c.text, ...where, ...media, ...replies].join('\n');
    });
    const doc = `## ${tab === 'resolved' ? 'Resolved' : 'Open'} comments (${shown.length})\n\n${lines.join('\n\n')}\n`;
    void navigator.clipboard.writeText(doc).then(() => {
      setCopiedTick(true);
      window.setTimeout(() => setCopiedTick(false), 1600);
    });
  };

  const tabBtn = (key: 'open' | 'resolved' | 'deleted', label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      style={{
        border: 'none',
        background: 'transparent',
        padding: '9px 2px',
        marginRight: 16,
        flex: 'none',
        whiteSpace: 'nowrap',
        fontSize: 12.5,
        fontWeight: 600,
        cursor: 'pointer',
        color: tab === key ? '#1b1926' : '#8a879a',
        borderBottom: `2px solid ${tab === key ? ACCENT : 'transparent'}`,
      }}
    >
      {label}
    </button>
  );

  return (
    <aside
      aria-label="All comments"
      style={{
        position: 'fixed',
        visibility: hidden ? 'hidden' : undefined,
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(440px, 100vw)',
        boxSizing: 'border-box',
        background: '#fff',
        borderLeft: '1px solid #e5e4ec',
        boxShadow: '-14px 0 34px -22px rgba(20,20,30,.35)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 2147482900,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '13px 16px 0',
        }}
      >
        <b style={{ fontSize: 13.5, color: '#1b1926' }}>Comments</b>
        <span style={{ fontSize: 11, color: '#8a879a' }}>across all pages</span>
        {shown.length > 0 && (
          <button
            type="button"
            onClick={copyShown}
            title={`Copy the ${tab === 'resolved' ? 'resolved' : 'open'} comments as text`}
            aria-label="Copy the listed comments"
            style={{
              marginLeft: 'auto',
              border: 'none',
              background: 'transparent',
              color: copiedTick ? '#2e7d32' : '#8a879a',
              cursor: 'pointer',
              padding: 2,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
            }}
          >
            {copiedTick && 'Copied'}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          </button>
        )}
        {shown.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const next = new Set(collapsed);
              for (const { c } of shown) {
                if (allFolded) next.delete(c.id);
                else next.add(c.id);
              }
              setFold(next);
            }}
            title={allFolded ? 'Expand all comments' : 'Collapse all comments to one line'}
            aria-label={allFolded ? 'Expand all comments' : 'Collapse all comments'}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#8a879a',
              cursor: 'pointer',
              padding: 2,
              display: 'inline-flex',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {allFolded ? (
                <>
                  <path d="m7 4 5 5 5-5" />
                  <path d="m7 20 5-5 5 5" />
                </>
              ) : (
                <>
                  <path d="m7 9 5-5 5 5" />
                  <path d="m7 15 5 5 5-5" />
                </>
              )}
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comments"
          style={{
            marginLeft: shown.length > 0 ? 0 : 'auto',
            border: 'none',
            background: 'transparent',
            color: '#8a879a',
            cursor: 'pointer',
            padding: 2,
          }}
        >
          <CloseIcon size={13} />
        </button>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          borderBottom: '1px solid #eeedf3',
        }}
      >
        {tabBtn('open', `Open (${openCount})`)}
        {tabBtn('resolved', `Resolved (${numbered.length - openCount})`)}
        {tabBtn('deleted', `Deleted (${deleted.length})`)}
        {tab === 'resolved' && numbered.length - openCount > 0 && (
          <button
            type="button"
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                return;
              }
              setConfirmClear(false);
              onClearResolved();
            }}
            onMouseLeave={() => setConfirmClear(false)}
            title="Delete every resolved comment"
            style={{
              marginLeft: 'auto',
              flex: 'none',
              whiteSpace: 'nowrap',
              border: `1px solid ${confirmClear ? '#b3261e' : '#e2e0ea'}`,
              background: confirmClear ? '#fbe9e7' : '#fff',
              color: '#b3261e',
              borderRadius: 8,
              height: 26,
              padding: '0 10px',
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {confirmClear ? `Really delete ${numbered.length - openCount}?` : 'Delete all'}
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px 90px' }}>
        {tab === 'deleted' && <DeletedList deleted={deleted} onRestore={onRestore} />}
        {tab !== 'deleted' && shown.length === 0 && (
          <p style={{ padding: '26px 10px', fontSize: 12.5, color: '#8a879a', textAlign: 'center' }}>
            {tab === 'open'
              ? 'No open comments. Use the pencil, then click any element.'
              : 'Nothing resolved yet.'}
          </p>
        )}
        {tab !== 'deleted' &&
          shown.map(({ c, n: i }) => (
          <div
            key={c.id}
            ref={(el) => {
              if (el) cardRefs.current.set(c.id, el);
              else cardRefs.current.delete(c.id);
            }}
            onMouseEnter={() => onHover(c.id)}
            onMouseLeave={() => onHover(null)}
            style={{
              border: `1px solid ${focusId === c.id ? ACCENT : '#eeedf3'}`,
              borderRadius: 12,
              padding: collapsed.has(c.id) ? '7px 12px' : '10px 12px',
              marginBottom: 8,
              opacity: c.resolved ? 0.55 : 1,
              background: '#fff',
            }}
          >
            <div
              onClick={() => toggleFold(c.id)}
              title={collapsed.has(c.id) ? 'Expand' : 'Collapse'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                marginBottom: collapsed.has(c.id) ? 0 : 6,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  flex: 'none',
                  borderRadius: '50%',
                  background: c.color ?? ACCENT,
                  color: '#fff',
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {i}
              </span>
              <b style={{ fontSize: 12.5, color: '#1b1926', flex: 'none' }}>{c.author ?? me}</b>
              <span style={{ fontSize: 11, color: '#8a879a', flex: 'none' }}>
                {timeAgo(c.createdAt)}
              </span>
              {c.resolved && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: '#1c8a5c',
                    background: '#e4f5ec',
                    borderRadius: 8,
                    padding: '2px 7px',
                    flex: 'none',
                  }}
                >
                  resolved
                </span>
              )}
              {collapsed.has(c.id) && (
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    color: '#6b6880',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {bodyOf(c).split('\n')[0]}
                </span>
              )}
              {collapsed.has(c.id) && (c.replies?.length ?? 0) > 0 && (
                <span style={{ fontSize: 10.5, color: '#8a879a', flex: 'none' }}>
                  {c.replies?.length} {c.replies?.length === 1 ? 'reply' : 'replies'}
                </span>
              )}
              <span
                aria-hidden
                style={{
                  marginLeft: 'auto',
                  flex: 'none',
                  color: '#8a879a',
                  display: 'inline-flex',
                  transform: collapsed.has(c.id) ? 'rotate(-90deg)' : 'none',
                  transition: 'transform .12s ease',
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </span>
            </div>
            {!collapsed.has(c.id) && c.viewport && (
              <span
                title={c.viewport.ua}
                style={{
                  display: 'inline-block',
                  background: '#f3f2f8',
                  color: '#6b6880',
                  borderRadius: 7,
                  padding: '2px 8px',
                  fontSize: 10.5,
                  fontFamily: 'ui-monospace, monospace',
                  marginBottom: 6,
                  marginRight: 6,
                }}
              >
                {c.viewport.device} · {c.viewport.w}×{c.viewport.h}
              </span>
            )}
            {!collapsed.has(c.id) && (
              <PlaceLine
                c={c}
                route={route}
                status={statuses.get(c.id)}
                onOpen={() => onOpenComment(c)}
              />
            )}
            {!collapsed.has(c.id) && (
              <>
                <CardBody
                  c={c}
                  onEdit={onEdit}
                  onResolve={onResolve}
                  onDelete={onDelete}
                  onReply={() => setReplyingId(c.id)}
                  onCapture={onCapture}
                />
                <Replies
                  c={c}
                  open={replyingId === c.id}
                  onClose={() => setReplyingId(null)}
                  onReply={onReply}
                  onDeleteReply={onDeleteReply}
                />
              </>
            )}
          </div>
          ))}
      </div>
    </aside>
  );
}

/** The Deleted tab: what was removed, newest first, each restorable in one click. */
function DeletedList({
  deleted,
  onRestore,
}: {
  deleted: ReviewComment[];
  onRestore: (c: ReviewComment) => void;
}) {
  if (deleted.length === 0) {
    return (
      <p style={{ padding: '26px 10px', fontSize: 12.5, color: '#8a879a', textAlign: 'center' }}>
        Nothing deleted. A deleted comment lands here and can be restored.
      </p>
    );
  }
  return (
    <>
      {deleted.map((c) => (
        <div
          key={c.id}
          style={{
            border: '1px solid #eeedf3',
            borderRadius: 12,
            padding: '10px 12px',
            marginBottom: 8,
            background: '#faf9fc',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
            <b style={{ fontSize: 12.5, color: '#1b1926' }}>{c.author ?? 'Anonymous'}</b>
            {c.deletedAt && (
              <span style={{ fontSize: 11, color: '#8a879a' }}>deleted {timeAgo(c.deletedAt)}</span>
            )}
            <button
              type="button"
              onClick={() => onRestore(c)}
              title="Put this comment back with its pin, thread and images"
              style={{
                marginLeft: 'auto',
                border: '1px solid #d8d5e6',
                background: '#fff',
                color: ACCENT,
                borderRadius: 8,
                height: 26,
                padding: '0 12px',
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Restore
            </button>
          </div>
          {c.page && (
            <span
              style={{
                display: 'inline-block',
                background: '#f3f2f8',
                color: '#6b6880',
                borderRadius: 7,
                padding: '2px 8px',
                fontSize: 10.5,
                fontFamily: 'ui-monospace, monospace',
                marginBottom: 6,
              }}
            >
              {c.page}
            </span>
          )}
          <p style={{ margin: 0, fontSize: 12.5, color: '#3b3950', whiteSpace: 'pre-wrap' }}>
            {bodyOf(c)}
          </p>
          {c.images && c.images.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {c.images.map((url) => (
                <img
                  key={url}
                  src={url}
                  alt=""
                  style={{
                    width: 64,
                    height: 48,
                    objectFit: 'cover',
                    borderRadius: 8,
                    border: '1px solid #e3e1ec',
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

const placeChip = {
  border: 'none',
  borderRadius: 7,
  padding: '2px 8px',
  fontSize: 10.5,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/** Where the comment lives: page chip, placement status, and the element it points at. */
function PlaceLine({
  c,
  route,
  status,
  onOpen,
}: {
  c: ReviewComment;
  route: string;
  status: PinStatus | undefined;
  onOpen: () => void;
}) {
  const anchors = anchorsOf(c);
  const otherPage = !!c.page && c.page !== route;
  if (!otherPage && status !== 'missing' && status !== 'here' && anchors.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
      {otherPage && (
        <button
          type="button"
          onClick={onOpen}
          title="Go to this page"
          style={{
            ...placeChip,
            background: '#f3f2f8',
            color: '#6b6880',
            fontFamily: 'ui-monospace, monospace',
            cursor: 'pointer',
          }}
        >
          {c.page} ↗
        </button>
      )}
      {status === 'missing' && (
        <span
          title="The pinned element isn't on this screen any more — the grey dashed pin marks the comment's original spot"
          style={{ ...placeChip, background: '#fdf3e2', color: '#9a6b15', fontWeight: 600 }}
        >
          element missing on this build
        </span>
      )}
      {status === 'here' && (
        <span style={{ ...placeChip, background: '#e4f5ec', color: '#1c8a5c', fontWeight: 600 }}>
          on this screen
        </span>
      )}
      {anchors.length > 0 && (
        <span
          title={anchors.map(anchorLabel).join('\n')}
          style={{
            fontSize: 10.5,
            color: '#8a879a',
            fontFamily: 'ui-monospace, monospace',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {anchorLabel(anchors[0])}
          {anchors.length > 1 ? ` +${anchors.length - 1}` : ''}
        </span>
      )}
    </div>
  );
}

/** A comment's text, images and actions — editable in place after the fact. */
function CardBody({
  c,
  onEdit,
  onResolve,
  onDelete,
  onReply,
  onCapture,
}: {
  c: ReviewComment;
  onEdit: (c: ReviewComment, patch: { text: string; images?: string[]; videos?: string[] }) => void;
  onResolve: (c: ReviewComment) => void;
  onDelete: (c: ReviewComment) => void;
  onReply: () => void;
  onCapture: (busy: boolean) => void;
}) {
  const { uploadImage } = useApi();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [videos, setVideos] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const addImageFiles = async (files: Iterable<File>) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const url = await uploadImage(f);
        setImages((cur) => [...cur, url]);
      } catch (e) {
        reportError('upload', e, { during: 'attach image to edit' });
        /* keep editing; the image just didn't attach */
      }
    }
  };

  const start = () => {
    setText(bodyOf(c));
    setImages(c.images ?? []);
    setVideos(c.videos ?? []);
    setEditing(true);
  };
  const save = () => {
    onEdit(c, {
      text: text.trim() || (videos.length ? '(recording)' : '(image)'),
      images: images.length ? images : undefined,
      videos: videos.length ? videos : undefined,
    });
    setEditing(false);
  };

  if (editing) {
    return (
      <>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              void addImageFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
            if (e.key === 'Escape') setEditing(false);
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            height: 66,
            resize: 'vertical',
            border: '1px solid #dcdae6',
            borderRadius: 9,
            padding: '7px 9px',
            fontSize: 12.5,
            fontFamily: 'inherit',
            marginBottom: 8,
          }}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {images.map((url) => (
            <span key={url} style={{ position: 'relative' }}>
              <img
                src={url}
                alt=""
                style={{
                  width: 64,
                  height: 48,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid #e3e1ec',
                  display: 'block',
                }}
              />
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => setImages((cur) => cur.filter((u) => u !== url))}
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  width: 17,
                  height: 17,
                  borderRadius: 9,
                  border: 'none',
                  background: '#1b1926',
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
              >
                <CloseIcon size={9} />
              </button>
            </span>
          ))}
        </div>
        {videos.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {videos.map((url) => (
              <span key={url} style={{ position: 'relative' }}>
                <video src={url} controls preload="metadata" style={clipStyle} />
                <button
                  type="button"
                  aria-label="Remove recording"
                  onClick={() => setVideos((cur) => cur.filter((u) => u !== url))}
                  style={removeBtn}
                >
                  <CloseIcon size={9} />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={async (e) => {
            await addImageFiles(e.target.files ?? []);
            e.target.value = '';
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: -5, flexWrap: 'wrap' }}>
          <SnapButton
            onDone={(url) => setImages((cur) => [...cur, url])}
            onBusy={onCapture}
            style={sideIconBtn}
            className="rt-ibtn"
            iconSize={14}
          />
          <RecordButton
            onDone={(url) => setVideos((cur) => [...cur, url])}
            onBusy={onCapture}
            style={sideIconBtn}
            className="rt-ibtn"
            iconSize={14}
          />
          <button
            type="button"
            className="rt-ibtn"
            style={sideIconBtn}
            onClick={() => fileInput.current?.click()}
            title="Add images from your computer"
            aria-label="Add images"
          >
            <ImagePlusIcon size={14} />
          </button>
          <button
            type="button"
            style={{ ...sideBtn, marginLeft: 'auto', background: ACCENT, color: '#fff', border: 'none' }}
            onClick={save}
          >
            Save
          </button>
          <button type="button" style={sideBtn} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p
        style={{
          margin: '0 0 8px',
          fontSize: 13,
          lineHeight: 1.55,
          color: '#37344a',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {bodyOf(c)}
      </p>
      {c.images && c.images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {c.images.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" title="Open full size">
              <img
                src={url}
                alt="attachment"
                style={{
                  width: 88,
                  height: 62,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid #e3e1ec',
                  display: 'block',
                }}
              />
            </a>
          ))}
        </div>
      )}
      {c.videos && c.videos.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {c.videos.map((url) => (
            <video
              key={url}
              src={url}
              controls
              preload="metadata"
              style={{ ...clipStyle, width: 280, maxHeight: 180 }}
            />
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={sideBtn} onClick={onReply}>
          Reply
        </button>
        <button type="button" style={sideBtn} onClick={() => onResolve(c)}>
          {c.resolved ? 'Reopen' : 'Resolve'}
        </button>
        <button type="button" style={sideBtn} onClick={start}>
          Edit
        </button>
        <ConfirmDelete
          label="Delete"
          ariaLabel="Delete comment"
          style={{ ...sideBtn, color: '#b3261e' }}
          onConfirm={() => onDelete(c)}
        />
      </div>
    </>
  );
}

const clipStyle = {
  width: 200,
  maxHeight: 130,
  borderRadius: 8,
  border: '1px solid #e3e1ec',
  display: 'block',
  background: '#000',
} as const;

const removeBtn = {
  position: 'absolute',
  top: -6,
  right: -6,
  width: 17,
  height: 17,
  borderRadius: 9,
  border: 'none',
  background: '#1b1926',
  color: '#fff',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
} as const;

/** Borderless icon buttons for attachments; colours and hover come from .rt-ibtn in TOOLBAR_CSS. */
const attachBtn = {
  width: 28,
  height: 28,
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  flex: 'none',
} as const;

/**
 * Delete takes two presses: the first turns the control into a red "Delete?"
 * and the second does it. Moving the pointer away, pressing Escape or waiting
 * three seconds puts it back — a list that shifts under a double-click must
 * not take the next card with it.
 */
function ConfirmDelete({
  onConfirm,
  label,
  armedLabel = 'Delete?',
  style,
  icon,
  ariaLabel,
}: {
  onConfirm: () => void;
  /** The idle face — text, or an icon when `icon` is set. */
  label?: string;
  armedLabel?: string;
  style?: React.CSSProperties;
  icon?: React.ReactNode;
  ariaLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setArmed(false);
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [armed]);
  return (
    <button
      type="button"
      aria-label={armed ? `Confirm: ${ariaLabel ?? label ?? 'delete'}` : (ariaLabel ?? label)}
      title={armed ? 'Press again to delete' : ariaLabel}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      onMouseLeave={() => setArmed(false)}
      style={{
        ...style,
        ...(armed
          ? { color: '#fff', background: '#b3261e', borderColor: '#b3261e', fontWeight: 700 }
          : undefined),
      }}
    >
      {armed ? armedLabel : (icon ?? label)}
    </button>
  );
}

const sideBtn = {
  border: '1px solid #e2e0ea',
  background: '#fff',
  color: '#4a4760',
  borderRadius: 8,
  height: 26,
  padding: '0 10px',
  fontSize: 11.5,
  fontWeight: 600,
  cursor: 'pointer',
} as const;

const sideIconBtn = { ...attachBtn, width: 26, height: 26 } as const;

/** The one-level thread under a comment; the box to add to it opens from the card's Reply button. */
function Replies({
  c,
  open,
  onClose,
  onReply,
  onDeleteReply,
}: {
  c: ReviewComment;
  open: boolean;
  onClose: () => void;
  onReply: (c: ReviewComment, text: string) => Promise<void>;
  onDeleteReply: (c: ReviewComment, replyId: string) => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const replies = c.replies ?? [];

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await onReply(c, t);
      setText('');
      onClose();
    } finally {
      setSending(false);
    }
  };

  if (replies.length === 0 && !open) return null;

  return (
    <div style={{ marginTop: 10, paddingLeft: 10, borderLeft: '2px solid #eeedf3' }}>
      {replies.map((r) => (
        <div key={r.id} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <b style={{ fontSize: 12, color: '#1b1926' }}>{r.author ?? 'Anonymous'}</b>
            <span style={{ fontSize: 10.5, color: '#8a879a' }}>{timeAgo(r.createdAt)}</span>
            <ConfirmDelete
              ariaLabel="Delete reply"
              armedLabel="Delete?"
              icon={<CloseIcon size={9} />}
              onConfirm={() => onDeleteReply(c, r.id)}
              style={{
                marginLeft: 'auto',
                border: 'none',
                background: 'transparent',
                color: '#a5a2b3',
                cursor: 'pointer',
                padding: '2px 4px',
                borderRadius: 6,
                fontSize: 10.5,
                display: 'inline-flex',
                alignItems: 'center',
              }}
            />
          </div>
          <p
            style={{
              margin: '2px 0 0',
              fontSize: 12.5,
              lineHeight: 1.5,
              color: '#37344a',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {r.text}
          </p>
        </div>
      ))}
      {open && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea
            autoFocus
            value={text}
            rows={2}
            placeholder="Write a reply… Enter sends, Shift+Enter for a new line"
            aria-label="Reply"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
              if (e.key === 'Escape') onClose();
            }}
            style={{
              flex: 1,
              minWidth: 0,
              boxSizing: 'border-box',
              minHeight: 44,
              maxHeight: 120,
              resize: 'vertical',
              border: '1px solid #dcdae6',
              borderRadius: 9,
              padding: '6px 9px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              lineHeight: 1.45,
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 'none' }}>
            <button
              type="button"
              disabled={sending || !text.trim()}
              onClick={() => void send()}
              style={{
                ...sideBtn,
                background: ACCENT,
                color: '#fff',
                border: 'none',
                opacity: text.trim() ? 1 : 0.5,
              }}
            >
              Send
            </button>
            <button type="button" style={sideBtn} onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- name flow */

function NameModal({ onDone, onCancel }: { onDone: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const submit = () => {
    const v = name.trim();
    if (!v) return;
    try {
      localStorage.setItem(AUTHOR_KEY, v);
    } catch {
      /* still usable for the session */
    }
    onDone(v);
  };
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483100,
        background: 'rgba(20,20,30,.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{
          background: '#fff',
          border: '1px solid #e3e3ea',
          borderRadius: 16,
          padding: '26px 28px',
          width: 340,
          boxShadow: '0 10px 40px -18px rgba(20,20,30,.25)',
        }}
      >
        <h1 style={{ margin: '0 0 6px', fontSize: 17 }}>What's your name?</h1>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#666', lineHeight: 1.5 }}>
          It is shown on every comment you leave, so your teammates know who said what.
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            height: 40,
            padding: '0 12px',
            borderRadius: 10,
            border: '1px solid #d6d6df',
            fontSize: 14,
            marginBottom: 12,
          }}
        />
        <button
          type="submit"
          disabled={!name.trim()}
          style={{
            width: '100%',
            height: 38,
            borderRadius: 10,
            border: 'none',
            background: name.trim() ? ACCENT : '#c9c3dd',
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            cursor: name.trim() ? 'pointer' : 'default',
          }}
        >
          Start commenting
        </button>
      </form>
    </div>
  );
}

/* ----------------------------------------------------------------- toolbar */

export interface ToolbarProps {
  /** Where the reviewed app lives (see host.ts). */
  host: Host;
  /** The page the app is on now: path plus query. Comments are filed under it. */
  route: string;
  /** Go to a comment's page (its route chip, or a pin opened from another page). */
  onNavigate: (path: string) => void;
  /** Base of the comments API; `/__review/api` by default. */
  apiBase?: string;
  /** Tag sent on every comment created here and the scope of the lists (`?build=`). */
  build?: string;
  /** A known reviewer name: stored as if typed when none is stored yet, so the name prompt is skipped. */
  author?: string | null;
  /** The page a comment saved without one belongs to (comments from before pages were recorded). */
  defaultRoute?: string;
  /** Accessible name of the toolbar's region. */
  title?: string;
}

/**
 * A crash in the toolbar's own rendering takes only the toolbar down, never
 * the app under review, and is reported (events.ts).
 */
class ToolbarBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    // After this commit, so a crash on the first render finds the reporter set.
    setTimeout(() => reportError('crash', error, { componentStack: info.componentStack?.slice(0, 1200) }), 0);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The toolbar over `host`, talking to the API at `apiBase`. */
export function Toolbar({ host, apiBase, build, ...rest }: ToolbarProps) {
  const api = useMemo(() => createApi(apiBase, build), [apiBase, build]);
  const routeRef = useRef(rest.route);
  routeRef.current = rest.route;
  // Before any child's effect runs, so the first poll's failure is reported too.
  useLayoutEffect(
    () =>
      setReporter({
        base: api.base,
        build,
        route: () => routeRef.current,
        author: storedName,
        url: () => {
          try {
            return host.win()?.location.href ?? location.href;
          } catch {
            return location.href;
          }
        },
        viewport: () => {
          try {
            const win = host.win();
            return win ? captureViewport(win) : null;
          } catch {
            return null;
          }
        },
      }),
    [api, build, host],
  );
  return (
    <HostContext.Provider value={host}>
      <ApiContext.Provider value={api}>
        <ToolbarBoundary>
          <ToolbarBody host={host} {...rest} />
        </ToolbarBoundary>
      </ApiContext.Provider>
    </HostContext.Provider>
  );
}

function ToolbarBody({
  host,
  route,
  onNavigate,
  author: knownAuthor,
  defaultRoute,
  title = 'reviewlution',
}: Omit<ToolbarProps, 'apiBase' | 'build'>) {
  const api = useApi();
  const { addReply, deleteReply, createComment, deleteComment, listComments, listDeleted, patchComment, restoreComment } =
    api;
  const [author, setAuthor] = useState<string | null>(() => {
    const stored = storedName();
    if (stored || !knownAuthor) return stored;
    try {
      localStorage.setItem(AUTHOR_KEY, knownAuthor);
    } catch {
      /* still usable for the session */
    }
    return knownAuthor;
  });
  const [mode, setMode] = useState<Mode>('view');
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState<Draft>(storedDraft);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Map<string, PinStatus>>(new Map());
  const [deleted, setDeleted] = useState<ReviewComment[]>([]);
  const [askName, setAskName] = useState(false);
  // A capture or recording in progress: pins and chrome step aside so the page
  // is live (and out of the clip) until it ends.
  const [capturing, setCapturing] = useState(false);
  const capturingRef = useRef(false);
  const setCapture = useCallback((b: boolean) => {
    capturingRef.current = b;
    setCapturing(b);
  }, []);

  // Comments are shared state: everyone's resolves, replies and new pins show
  // up here without a reload. Polled while the tab is visible; an unchanged
  // payload is not re-rendered.
  const lastPayload = useRef('');
  const refresh = useCallback(async () => {
    try {
      const [live, gone] = await Promise.all([listComments(), listDeleted()]);
      const next = live
        .map((c) => (c.page || !defaultRoute ? c : { ...c, page: defaultRoute }))
        .sort((a, b) => a.createdAt - b.createdAt);
      const payload = JSON.stringify({ next, gone });
      if (payload === lastPayload.current) return;
      lastPayload.current = payload;
      setComments(next);
      setDeleted(gone);
    } catch (e) {
      reportError('fetch', e, { during: 'refresh' });
      /* transient — the next poll or mutation refreshes again */
    }
  }, [listComments, listDeleted, defaultRoute]);
  useEffect(() => {
    void refresh();
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = window.setInterval(tick, 5000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);

  const updateDraft = useCallback((d: Draft) => {
    setDraft(d);
    persistDraft(d);
  }, []);

  // Entering annotate needs a name once; leaving it keeps the draft, drops the pin.
  const toggleMode = useCallback(() => {
    setMode((m) => {
      if (m === 'annotate') {
        setPending(null);
        return 'view';
      }
      if (!storedName()) {
        setAskName(true);
        return m;
      }
      return 'annotate';
    });
  }, []);

  // ⌥C toggles annotate mode, ⌥L the comment list, Escape leaves annotate —
  // in the toolbar's window and the app's, when the app has its own (a frame). Chords instead of bare letters: plain typing or a
  // stray keypress while browsing can never trigger them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape and the chords would unmount the dialog that owns the recording.
      if (capturingRef.current) return;
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyC') {
        e.preventDefault();
        toggleMode();
        return;
      }
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyL') {
        e.preventDefault();
        setSidebarOpen((o) => !o);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Escape') {
        setPending(null);
        setMode('view');
      }
    };
    window.addEventListener('keydown', onKey);
    const attach = () => {
      const win = host.win() as (Window & { __reviewKeys?: boolean }) | null;
      if (!win || win === window || win.__reviewKeys) return;
      try {
        win.addEventListener('keydown', onKey);
        win.__reviewKeys = true;
      } catch {
        /* not same-origin-ready yet */
      }
    };
    attach();
    const tick = setInterval(attach, 800);
    return () => {
      clearInterval(tick);
      window.removeEventListener('keydown', onKey);
      try {
        const win = host.win() as (Window & { __reviewKeys?: boolean }) | null;
        if (win && win !== window) {
          win.removeEventListener('keydown', onKey);
          win.__reviewKeys = false;
        }
      } catch {
        /* gone with the frame */
      }
    };
  }, [host, toggleMode]);

  // Clicking a selected element again unselects it; a new one joins the comment.
  const addAnchor = useCallback((a: Anchor) => {
    setPending((p) => {
      if (!p) return p;
      const has = p.anchors.some((x) => x.selector === a.selector);
      const anchors = has ? p.anchors.filter((x) => x.selector !== a.selector) : [...p.anchors, a];
      return { ...p, anchors, anchor: anchors[0] ?? null };
    });
  }, []);
  const removeAnchor = useCallback((i: number) => {
    setPending((p) => {
      if (!p) return p;
      const anchors = p.anchors.filter((_, k) => k !== i);
      return { ...p, anchors, anchor: anchors[0] ?? null };
    });
  }, []);

  const submit = useCallback(async () => {
    if (!pending) return;
    const c: ReviewComment = {
      id: crypto.randomUUID(),
      text: draft.text.trim() || (draft.videos.length ? '(recording)' : '(image)'),
      x: pending.x,
      y: pending.y,
      createdAt: Date.now(),
      color: ACCENT,
      author: storedName() ?? author ?? 'Anonymous',
      page: pending.page,
      images: draft.images.length ? draft.images : undefined,
      videos: draft.videos.length ? draft.videos : undefined,
      anchor: pending.anchor ?? undefined,
      anchors: pending.anchors.length > 1 ? pending.anchors : undefined,
      viewport: captureViewport(host.win() ?? window),
    };
    await createComment(c);
    updateDraft(EMPTY_DRAFT);
    setPending(null);
    setMode('view');
    await refresh();
  }, [pending, draft, author, host, createComment, refresh, updateDraft]);

  const openComment = useCallback(
    (c: ReviewComment) => {
      setFocusId(c.id);
      setSidebarOpen(true);
      if (c.page && c.page !== route) onNavigate(c.page);
    },
    [route, onNavigate],
  );

  const resolve = useCallback(
    async (c: ReviewComment) => {
      await patchComment(c.id, { resolved: !c.resolved });
      await refresh();
    },
    [api, refresh],
  );
  const move = useCallback(
    async (id: string, patch: Partial<ReviewComment>) => {
      await patchComment(id, patch);
      await refresh();
    },
    [api, refresh],
  );
  const reply = useCallback(
    async (c: ReviewComment, text: string) => {
      const name = storedName();
      if (!name) {
        setAskName(true);
        return;
      }
      await addReply(c.id, text, name);
      await refresh();
    },
    [api, refresh],
  );
  const removeReply = useCallback(
    async (c: ReviewComment, replyId: string) => {
      await deleteReply(c.id, replyId);
      await refresh();
    },
    [api, refresh],
  );
  const edit = useCallback(
    async (c: ReviewComment, patch: { text: string; images?: string[]; videos?: string[] }) => {
      await patchComment(c.id, patch);
      await refresh();
    },
    [api, refresh],
  );
  const clearResolved = useCallback(async () => {
    for (const c of comments.filter((x) => x.resolved)) {
      await deleteComment(c.id);
    }
    await refresh();
  }, [api, comments, refresh]);
  const remove = useCallback(
    async (c: ReviewComment) => {
      await deleteComment(c.id);
      await refresh();
    },
    [api, refresh],
  );
  const restore = useCallback(
    async (c: ReviewComment) => {
      await restoreComment(c.id);
      await refresh();
    },
    [api, refresh],
  );

  return (
    <div {...{ [TOOLBAR_ATTR]: '' }} role="region" aria-label={title} style={{ fontFamily: FONT }}>
      <style>{TOOLBAR_CSS}</style>
      <PinLayer
        comments={comments}
        route={route}
        mode={capturing ? 'view' : mode}
        pending={capturing ? null : pending}
        hoverId={hoverId ?? focusId}
        onPlace={setPending}
        onAddAnchor={addAnchor}
        onPinClick={(id) => {
          const c = comments.find((x) => x.id === id);
          if (c) openComment(c);
        }}
        onMove={move}
        onStatuses={setStatuses}
      />
      {pending && (
        <CreateDialog
          pending={pending}
          draft={draft}
          onDraft={updateDraft}
          onSubmit={submit}
          onClose={() => setPending(null)}
          onCapture={setCapture}
          onRemoveAnchor={removeAnchor}
        />
      )}
      {!capturing && (
        <Bubble
          author={author}
          mode={mode}
          count={comments.length}
          sidebarOpen={sidebarOpen}
          onToggleMode={toggleMode}
          onChangeName={() => setAskName(true)}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
        />
      )}
      {sidebarOpen && (
        <Sidebar
          hidden={capturing}
          onCapture={setCapture}
          me={author ?? 'Anonymous'}
          route={route}
          comments={comments}
          focusId={focusId}
          onHover={setHoverId}
          statuses={statuses}
          onOpenComment={openComment}
          onEdit={(c, patch) => void edit(c, patch)}
          onResolve={(c) => void resolve(c)}
          onDelete={(c) => void remove(c)}
          onReply={reply}
          onDeleteReply={(c, rid) => void removeReply(c, rid)}
          deleted={deleted}
          onRestore={(c) => void restore(c)}
          onClearResolved={() => void clearResolved()}
          onClose={() => {
            setSidebarOpen(false);
            setFocusId(null);
          }}
        />
      )}
      {askName && (
        <NameModal
          onCancel={() => setAskName(false)}
          onDone={(name) => {
            const hadName = !!author;
            setAuthor(name);
            setAskName(false);
            if (!hadName) setMode('annotate');
          }}
        />
      )}
    </div>
  );
}
