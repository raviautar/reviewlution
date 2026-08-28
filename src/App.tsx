/**
 * Review shell: the studio preview in a same-origin iframe (the server proxies
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
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACCENT,
  AUTHOR_KEY,
  DRAFT_KEY,
  POS_KEY,
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
import { anchorAt, resolveAnchor, type Anchor } from './anchors.js';
import { ChatIcon, CloseIcon, GripIcon, ImagePlusIcon, PencilIcon } from './icons.js';

type Mode = 'view' | 'annotate';
type Draft = { text: string; images: string[] };
type Pending = { anchor: Anchor | null; x: number; y: number; cx: number; cy: number };

const EMPTY_DRAFT: Draft = { text: '', images: [] };

function storedDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY_DRAFT;
    const d = JSON.parse(raw) as Draft;
    return typeof d.text === 'string' && Array.isArray(d.images) ? d : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}

function persistDraft(d: Draft) {
  try {
    if (!d.text && d.images.length === 0) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* draft just won't survive a reload */
  }
}

/** The route this page was opened on; /__review itself falls back to the hub. */
function initialRoute(): string {
  const path = location.pathname + location.search;
  if (path === '/' || path.startsWith('/__review')) return '/integrations';
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

function PinLayer({
  iframeRef,
  comments,
  route,
  mode,
  pending,
  hoverId,
  onPlace,
  onPinClick,
}: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  comments: ReviewComment[];
  route: string;
  mode: Mode;
  pending: Pending | null;
  hoverId: string | null;
  onPlace: (p: Pending) => void;
  onPinClick: (id: string) => void;
}) {
  const [pins, setPins] = useState<PinPos[]>([]);
  const [pendingPos, setPendingPos] = useState<{ x: number; y: number } | null>(null);
  const cache = useRef(new Map<string, Element>());

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
          pos = resolveAnchor(doc, c.anchor, cache.current, c.id);
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
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [iframeRef, comments, route, pending]);

  const place = (e: React.MouseEvent) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    cache.current.delete('__pending');
    onPlace({
      anchor: anchorAt(doc, e.clientX, e.clientY),
      x: (e.clientX / window.innerWidth) * 100,
      y: (e.clientY / window.innerHeight) * 100,
      cx: e.clientX,
      cy: e.clientY,
    });
  };

  return (
    <div
      onClick={mode === 'annotate' ? place : undefined}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147482800,
        pointerEvents: mode === 'annotate' ? 'auto' : 'none',
        cursor: mode === 'annotate' ? 'crosshair' : undefined,
      }}
    >
      {pins.map((p) => (
        <button
          key={p.id}
          type="button"
          title="Open this comment"
          onClick={(e) => {
            e.stopPropagation();
            onPinClick(p.id);
          }}
          style={{
            position: 'absolute',
            left: p.x - 11,
            top: p.y - 11,
            width: 22,
            height: 22,
            borderRadius: '50% 50% 50% 4px',
            border: '2px solid #fff',
            background: ACCENT,
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            pointerEvents: 'auto',
            padding: 0,
            opacity: p.resolved ? 0.45 : 1,
            boxShadow:
              hoverId === p.id
                ? `0 0 0 3px ${ACCENT}55, 0 4px 10px -4px rgba(20,20,30,.5)`
                : '0 4px 10px -4px rgba(20,20,30,.5)',
          }}
        >
          {p.n}
        </button>
      ))}
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
        title={annotate ? 'Stop commenting (C)' : 'Comment: click any element (C)'}
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
        title="All comments"
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
}: {
  pending: Pending;
  draft: Draft;
  onDraft: (d: Draft) => void;
  onSubmit: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canSubmit = !!draft.text.trim() || draft.images.length > 0;

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
  const top = Math.min(Math.max(pending.cy + 14, 12), window.innerHeight - 320);

  return (
    <div
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
      {error && <p style={{ margin: '8px 0 0', fontSize: 12, color: '#b3261e' }}>{error}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
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
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          title="Attach images"
          style={{
            border: '1px solid #dcdae6',
            background: '#fff',
            color: '#4a4760',
            borderRadius: 9,
            height: 30,
            padding: '0 11px',
            fontSize: 12,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <ImagePlusIcon size={13} />
          Add images
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
  onClose,
}: {
  me: string;
  route: string;
  comments: ReviewComment[];
  focusId: string | null;
  onHover: (id: string | null) => void;
  onOpenComment: (c: ReviewComment) => void;
  onEdit: (c: ReviewComment, patch: { text: string; images?: string[] }) => void;
  onResolve: (c: ReviewComment) => void;
  onDelete: (c: ReviewComment) => void;
  onClose: () => void;
}) {
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [tab, setTab] = useState<'open' | 'resolved'>('open');

  // Numbering stays global (matches the pins); the tabs only filter the view.
  const numbered = comments.map((c, i) => ({ c, n: i + 1 }));
  const shown = numbered.filter(({ c }) => (tab === 'resolved' ? c.resolved : !c.resolved));
  const openCount = numbered.length - numbered.filter(({ c }) => c.resolved).length;

  useEffect(() => {
    if (!focusId) return;
    const target = comments.find((c) => c.id === focusId);
    if (target?.resolved) setTab('resolved');
    cardRefs.current.get(focusId)?.scrollIntoView({ block: 'center' });
  }, [focusId, comments]);

  const tabBtn = (key: 'open' | 'resolved', label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      style={{
        border: 'none',
        background: 'transparent',
        padding: '9px 2px',
        marginRight: 16,
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
        top: 0,
        right: 0,
        bottom: 0,
        width: 330,
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
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comments"
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
      <div style={{ padding: '0 16px', borderBottom: '1px solid #eeedf3' }}>
        {tabBtn('open', `Open (${openCount})`)}
        {tabBtn('resolved', `Resolved (${numbered.length - openCount})`)}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px 90px' }}>
        {shown.length === 0 && (
          <p style={{ padding: '26px 10px', fontSize: 12.5, color: '#8a879a', textAlign: 'center' }}>
            {tab === 'open'
              ? 'No open comments. Use the pencil (or press C), then click any element.'
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
              padding: '10px 12px',
              marginBottom: 8,
              opacity: c.resolved ? 0.55 : 1,
              background: '#fff',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
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
              <b style={{ fontSize: 12.5, color: '#1b1926' }}>{c.author ?? me}</b>
              <span style={{ fontSize: 11, color: '#8a879a' }}>{timeAgo(c.createdAt)}</span>
              {c.resolved && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: '#1c8a5c',
                    background: '#e4f5ec',
                    borderRadius: 8,
                    padding: '2px 7px',
                  }}
                >
                  resolved
                </span>
              )}
            </div>
            {c.page && c.page !== route && (
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
            <CardBody c={c} onEdit={onEdit} onResolve={onResolve} onDelete={onDelete} />
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
}: {
  c: ReviewComment;
  onEdit: (c: ReviewComment, patch: { text: string; images?: string[] }) => void;
  onResolve: (c: ReviewComment) => void;
  onDelete: (c: ReviewComment) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const start = () => {
    setText(bodyOf(c));
    setImages(c.images ?? []);
    setEditing(true);
  };
  const save = () => {
    onEdit(c, { text: text.trim() || '(image)', images: images.length ? images : undefined });
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
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={sideBtn} onClick={() => fileInput.current?.click()}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <ImagePlusIcon size={12} /> Add images
            </span>
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
      <div style={{ display: 'flex', gap: 6 }}>
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
  const [mode, setMode] = useState<Mode>('view');
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState<Draft>(storedDraft);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [askName, setAskName] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setComments((await listComments()).sort((a, b) => a.createdAt - b.createdAt));
    } catch {
      /* transient — next mutation refreshes again */
    }
  }, []);
  useEffect(() => {
    void refresh();
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

  // "C" toggles annotate everywhere — the shell and inside the iframe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === 'c' || e.key === 'C') toggleMode();
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

  const submit = useCallback(async () => {
    if (!pending) return;
    const c: ReviewComment = {
      id: crypto.randomUUID(),
      text: draft.text.trim() || '(image)',
      x: pending.x,
      y: pending.y,
      createdAt: Date.now(),
      color: ACCENT,
      author: storedName() ?? author ?? 'Anonymous',
      page: route,
      images: draft.images.length ? draft.images : undefined,
      anchor: pending.anchor ?? undefined,
    };
    await createComment(c);
    updateDraft(EMPTY_DRAFT);
    setPending(null);
    setMode('view');
    await refresh();
  }, [pending, draft, author, route, refresh, updateDraft]);

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
  const edit = useCallback(
    async (c: ReviewComment, patch: { text: string; images?: string[] }) => {
      await patchComment(c.id, patch);
      await refresh();
    },
    [refresh],
  );
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
          src={route}
          title="Studio preview"
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
        />
      </div>
      <PinLayer
        iframeRef={iframeRef}
        comments={comments}
        route={route}
        mode={mode}
        pending={pending}
        hoverId={hoverId ?? focusId}
        onPlace={setPending}
        onPinClick={(id) => {
          const c = comments.find((x) => x.id === id);
          if (c) openComment(c);
        }}
      />
      {pending && (
        <CreateDialog
          pending={pending}
          draft={draft}
          onDraft={updateDraft}
          onSubmit={submit}
          onClose={() => setPending(null)}
        />
      )}
      <Bubble
        author={author}
        mode={mode}
        count={comments.length}
        sidebarOpen={sidebarOpen}
        onToggleMode={toggleMode}
        onChangeName={() => setAskName(true)}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
      />
      {sidebarOpen && (
        <Sidebar
          me={author ?? 'Anonymous'}
          route={route}
          comments={comments}
          focusId={focusId}
          onHover={setHoverId}
          onOpenComment={openComment}
          onEdit={(c, patch) => void edit(c, patch)}
          onResolve={(c) => void resolve(c)}
          onDelete={(c) => void remove(c)}
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
