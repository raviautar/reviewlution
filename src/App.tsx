/**
 * Review shell: the app under review in a same-origin iframe (the server proxies
 * it), our own element-anchored pin layer on top, comments stored on this host.
 *
 * The shell is URL-transparent: the server hands this page out for any document
 * navigation, the iframe loads the same path, and SPA navigation inside the
 * iframe is mirrored back with replaceState — the address bar never shows
 * /__review. The iframe is never remounted; pins belong to elements, not to
 * scroll positions, so each frame their positions are read from the anchored
 * element's live bounding box. A pin whose element is not on the current DOM
 * simply has no dot — its comment stays in the sidebar, which always lists
 * every page's comments.
 */
import { useCallback, useEffect, useRef, useState, useLayoutEffect } from 'react';
import {
  ACCENT,
  AUTHOR_KEY,
  DRAFT_KEY,
  POS_KEY,
  addReply,
  deleteReply,
  bodyOf,
  createComment,
  deleteComment,
  listComments,
  patchComment,
  storedName,
  timeAgo,
  uploadImage,
  type ReviewComment,
} from './api.js';
import { anchorAt, anchorFor, elementsInRect, resolveAnchor, type Anchor, type Box } from './anchors.js';
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

/** Server-injected settings (see server.mjs): where `/` lands, and the tab title. */
const CONFIG: { defaultRoute: string; title: string } = {
  defaultRoute: '/',
  title: 'Preview · Review',
  ...((window as Window & { __WASHI__?: Partial<{ defaultRoute: string; title: string }> }).__WASHI__ ??
    {}),
};

/** The route this page was opened on; `/` and /__review itself fall back to the configured default. */
function initialRoute(): string {
  const path = location.pathname + location.search;
  if (path === '/' || path.startsWith('/__review')) return CONFIG.defaultRoute;
  return path;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  const tag = t.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t as HTMLElement).isContentEditable
  );
}

/* ---------------------------------------------------------------- pin layer */

type PinPos = { id: string; n: number; x: number; y: number; resolved: boolean };
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
  iframeRef,
  comments,
  route,
  mode,
  pending,
  hoverId,
  onPlace,
  onAddAnchor,
  onPinClick,
  onMove,
}: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
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
}) {
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
  const hoverEl = useRef<Element | null>(null);
  const [outline, setOutline] = useState<Outline | null>(null);
  // Dragging a pin: pointer capture keeps the events on the pin even over the
  // iframe, so no window listeners are needed; a 4px threshold separates a
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
      const doc = iframeRef.current?.contentDocument;
      if (!doc) return;
      const next: PinPos[] = [];
      comments.forEach((c, i) => {
        // Resolved comments live in the sidebar's Resolved tab, not on the page.
        if (c.resolved) return;
        let pos: { x: number; y: number } | null = null;
        if (c.anchor) {
          // Keyed by selector too, so a pin moved to another element re-resolves.
          pos = resolveAnchor(doc, c.anchor, cache.current, `${c.id}|${c.anchor.selector}`);
        } else if (c.page === route) {
          pos = { x: (c.x / 100) * window.innerWidth, y: (c.y / 100) * window.innerHeight };
        }
        if (!pos) return;
        if (pos.y < -20 || pos.y > window.innerHeight + 20) return;
        next.push({ id: c.id, n: i + 1, x: pos.x, y: pos.y, resolved: !!c.resolved });
      });
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
              p.resolved === q.resolved
            );
          })
        ) {
          return cur;
        }
        return next;
      });
      if (pending) {
        const pos = pending.anchor
          ? resolveAnchor(doc, pending.anchor, cache.current, '__pending')
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
  }, [iframeRef, comments, route, pending, mode, drag]);

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
    const el = iframeRef.current?.contentDocument?.elementFromPoint(e.clientX, e.clientY) ?? null;
    hoverEl.current = el && el.tagName !== 'HTML' && el.tagName !== 'BODY' ? el : null;
    setDrag({ id, x: e.clientX, y: e.clientY });
  };
  const pinPointerUp = (e: React.PointerEvent, id: string) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !d.moved) return;
    suppressClick.current = true;
    hoverEl.current = null;
    setDrag(null);
    const doc = iframeRef.current?.contentDocument;
    const anchor = doc ? anchorAt(doc, e.clientX, e.clientY) : null;
    if (!anchor) return;
    onMove(id, {
      anchor,
      x: (e.clientX / window.innerWidth) * 100,
      y: (e.clientY / window.innerHeight) * 100,
      page: route,
    });
  };

  const track = (e: React.MouseEvent) => {
    const el = iframeRef.current?.contentDocument?.elementFromPoint(e.clientX, e.clientY) ?? null;
    hoverEl.current = el && el.tagName !== 'HTML' && el.tagName !== 'BODY' ? el : null;
  };

  // The overlay swallows the wheel, so hand it to the scrollable ancestor under
  // the cursor — otherwise nothing below the fold can be commented on.
  const forwardWheel = (e: React.WheelEvent) => {
    const doc = iframeRef.current?.contentDocument;
    const win = doc?.defaultView;
    if (!doc || !win) return;
    let el: Element | null = doc.elementFromPoint(e.clientX, e.clientY);
    while (el) {
      const cs = win.getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) break;
      el = el.parentElement;
    }
    (el ?? doc.scrollingElement ?? doc.documentElement).scrollBy(e.deltaX, e.deltaY);
  };

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
  const bandUp = (e: React.PointerEvent) => {
    const b = bandRef.current;
    bandRef.current = null;
    const doc = iframeRef.current?.contentDocument;
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
  };

  return (
    <div
      onPointerDown={mode === 'annotate' ? bandDown : undefined}
      onPointerMove={mode === 'annotate' ? bandMove : undefined}
      onPointerUp={mode === 'annotate' ? bandUp : undefined}
      onMouseMove={mode === 'annotate' ? track : undefined}
      onMouseLeave={() => {
        hoverEl.current = null;
      }}
      onWheel={mode === 'annotate' ? forwardWheel : undefined}
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
            title="Open this comment · drag it onto another element to move it"
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
              border: `2px solid ${dragging ? HIGHLIGHT : '#fff'}`,
              background: ACCENT,
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
              opacity: p.resolved ? 0.45 : 1,
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
        ...(pos ? { left: pos.x, top: pos.y } : { right: 18, bottom: 18 }),
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
          className="washi-ibtn"
          iconSize={15}
        />
        <RecordButton
          onDone={(url) => onDraft({ ...draft, videos: [...draft.videos, url] })}
          onBusy={capture}
          style={attachBtn}
          className="washi-ibtn"
          iconSize={15}
        />
        <button
          type="button"
          className="washi-ibtn"
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

const COLLAPSED_KEY = 'washi-review-collapsed';

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
}: {
  /** Kept mounted but invisible while a capture runs from one of its cards. */
  hidden: boolean;
  onCapture: (busy: boolean) => void;
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
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
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
      where.push(`from: ${origin}${c.page ?? '/'}`, `comment id: ${c.id} (API: ${origin}/__review/api/comments/${c.id})`);
      return [head, c.text, ...where, ...media, ...replies].join('\n');
    });
    const doc = `## ${tab === 'resolved' ? 'Resolved' : 'Open'} comments (${shown.length})\n\n${lines.join('\n\n')}\n`;
    void navigator.clipboard.writeText(doc).then(() => {
      setCopiedTick(true);
      window.setTimeout(() => setCopiedTick(false), 1600);
    });
  };

  const tabBtn = (key: 'open' | 'resolved', label: string) => (
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
        {shown.length === 0 && (
          <p style={{ padding: '26px 10px', fontSize: 12.5, color: '#8a879a', textAlign: 'center' }}>
            {tab === 'open'
              ? 'No open comments. Use the pencil, then click any element.'
              : 'Nothing resolved yet.'}
          </p>
        )}
        {shown.map(({ c, n: i }) => (
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
            {!collapsed.has(c.id) && c.page && c.page !== route && (
              <button
                type="button"
                onClick={() => onOpenComment(c)}
                title="Go to this page"
                style={{
                  border: 'none',
                  background: '#f3f2f8',
                  color: '#6b6880',
                  borderRadius: 7,
                  padding: '2px 8px',
                  fontSize: 10.5,
                  fontFamily: 'ui-monospace, monospace',
                  cursor: 'pointer',
                  marginBottom: 6,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {c.page} ↗
              </button>
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
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [videos, setVideos] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

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
            for (const f of e.target.files ?? []) {
              if (!f.type.startsWith('image/')) continue;
              try {
                const url = await uploadImage(f);
                setImages((cur) => [...cur, url]);
              } catch {
                /* keep editing; the image just didn't attach */
              }
            }
            e.target.value = '';
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: -5, flexWrap: 'wrap' }}>
          <SnapButton
            onDone={(url) => setImages((cur) => [...cur, url])}
            onBusy={onCapture}
            style={sideIconBtn}
            className="washi-ibtn"
            iconSize={14}
          />
          <RecordButton
            onDone={(url) => setVideos((cur) => [...cur, url])}
            onBusy={onCapture}
            style={sideIconBtn}
            className="washi-ibtn"
            iconSize={14}
          />
          <button
            type="button"
            className="washi-ibtn"
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
        <button type="button" style={{ ...sideBtn, color: '#b3261e' }} onClick={() => onDelete(c)}>
          Delete
        </button>
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

/** Borderless icon buttons for attachments; colours and hover come from .washi-ibtn in index.html. */
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
            <button
              type="button"
              aria-label="Delete reply"
              title="Delete reply"
              onClick={() => onDeleteReply(c, r.id)}
              style={{
                marginLeft: 'auto',
                border: 'none',
                background: 'transparent',
                color: '#a5a2b3',
                cursor: 'pointer',
                padding: 2,
                display: 'inline-flex',
              }}
            >
              <CloseIcon size={9} />
            </button>
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

/* --------------------------------------------------------------------- app */

export function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [author, setAuthor] = useState<string | null>(storedName);
  const [route, setRoute] = useState(initialRoute);
  // The iframe's src is set once. Binding it to `route` would reload the studio
  // on every SPA navigation the poll below mirrors, wiping its in-page state.
  const [startRoute] = useState(initialRoute);
  const [mode, setMode] = useState<Mode>('view');
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState<Draft>(storedDraft);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
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
      const next = (await listComments()).sort((a, b) => a.createdAt - b.createdAt);
      const payload = JSON.stringify(next);
      if (payload === lastPayload.current) return;
      lastPayload.current = payload;
      setComments(next);
    } catch {
      /* transient — the next poll or mutation refreshes again */
    }
  }, []);
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
  // shell and iframe alike. Chords instead of bare letters: plain typing or a
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
      const win = iframeRef.current?.contentWindow as
        | (Window & { __reviewKeys?: boolean })
        | null
        | undefined;
      if (!win || win.__reviewKeys) return;
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
        iframeRef.current?.contentWindow?.removeEventListener('keydown', onKey);
      } catch {
        /* gone with the frame */
      }
    };
  }, [toggleMode]);

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
    };
    await createComment(c);
    updateDraft(EMPTY_DRAFT);
    setPending(null);
    setMode('view');
    await refresh();
  }, [pending, draft, author, refresh, updateDraft]);

  const openComment = useCallback(
    (c: ReviewComment) => {
      setFocusId(c.id);
      setSidebarOpen(true);
      if (c.page && c.page !== route) {
        try {
          iframeRef.current?.contentWindow?.location.assign(c.page);
        } catch {
          /* navigation just won't happen */
        }
      }
    },
    [route],
  );

  const resolve = useCallback(
    async (c: ReviewComment) => {
      await patchComment(c.id, { resolved: !c.resolved });
      await refresh();
    },
    [refresh],
  );
  const move = useCallback(
    async (id: string, patch: Partial<ReviewComment>) => {
      await patchComment(id, patch);
      await refresh();
    },
    [refresh],
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
    [refresh],
  );
  const removeReply = useCallback(
    async (c: ReviewComment, replyId: string) => {
      await deleteReply(c.id, replyId);
      await refresh();
    },
    [refresh],
  );
  const edit = useCallback(
    async (c: ReviewComment, patch: { text: string; images?: string[]; videos?: string[] }) => {
      await patchComment(c.id, patch);
      await refresh();
    },
    [refresh],
  );
  const clearResolved = useCallback(async () => {
    for (const c of comments.filter((x) => x.resolved)) {
      await deleteComment(c.id);
    }
    await refresh();
  }, [comments, refresh]);
  const remove = useCallback(
    async (c: ReviewComment) => {
      await deleteComment(c.id);
      await refresh();
    },
    [refresh],
  );

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
      <PinLayer
        iframeRef={iframeRef}
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
          onOpenComment={openComment}
          onEdit={(c, patch) => void edit(c, patch)}
          onResolve={(c) => void resolve(c)}
          onDelete={(c) => void remove(c)}
          onReply={reply}
          onDeleteReply={(c, rid) => void removeReply(c, rid)}
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
    </>
  );
}
