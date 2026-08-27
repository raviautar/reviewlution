/**
 * Review shell: the studio preview in a same-origin iframe (the server proxies
 * it), washi's pin engine on top, comments stored on this host.
 *
 * The shell is URL-transparent: the server hands this page out for any
 * document navigation, the iframe loads the same path, and SPA navigation
 * inside the iframe is mirrored back with replaceState — so the address bar
 * reads like the app's own, never /__review.
 *
 * Washi has no page concept — one mount renders every loaded comment — so the
 * adapter scopes comments by the iframe's route, and a route change remounts
 * the whole washi tree (keyed provider). The remount reloads the iframe at the
 * new route; the trade is a page refresh per navigation for pins that always
 * belong to the page under them.
 *
 * The bubble and both dialogs are this shell's own (washi's packaged ones have
 * no drag, no name, no images): a draggable bubble carrying the reviewer name,
 * a create popover that takes pasted or attached images, and a sidebar that a
 * pin click opens and scrolls.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CommentList,
  WashiFrame,
  WashiProvider,
  useWashiContext,
  type Comment,
  type WashiAdapter,
} from '@washi-ui/react';

const ACCENT = '#5b2fcc';
const AUTHOR_KEY = 'washi-review-author';
const POS_KEY = 'washi-review-bubble-pos';
const API = '/__review/api/comments';
const IMAGES_API = '/__review/api/images';

/** A comment as this shell stores it — washi's shape plus attribution. */
type ReviewComment = Comment & { author?: string; page?: string; images?: string[] };

function storedName(): string | null {
  try {
    return localStorage.getItem(AUTHOR_KEY);
  } catch {
    return null;
  }
}

class RestAdapter implements WashiAdapter {
  constructor(private readonly page: string) {}

  async save(c: Comment): Promise<void> {
    const author = storedName() ?? 'Anonymous';
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...c, page: this.page, author }),
    });
    if (!res.ok) throw new Error(`Saving the comment failed (${res.status})`);
  }

  async load(): Promise<Comment[]> {
    const res = await fetch(`${API}?page=${encodeURIComponent(this.page)}`);
    if (!res.ok) throw new Error(`Loading comments failed (${res.status})`);
    return (await res.json()) as Comment[];
  }

  async update(id: string, updates: Partial<Comment>): Promise<void> {
    const res = await fetch(`${API}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`Updating the comment failed (${res.status})`);
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Deleting the comment failed (${res.status})`);
  }
}

/** Author of a comment; a comment without the field was just created here. */
function authorOf(c: ReviewComment, me: string): string {
  return c.author ?? me;
}

/** Older comments carried the author as a trailing "— name" line; strip it. */
function bodyOf(c: ReviewComment): string {
  return c.author ? c.text.replace(new RegExp(`\\n— ${escapeRegExp(c.author)}$`), '') : c.text;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function timeAgo(at: number): string {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function uploadImage(file: File): Promise<string> {
  const res = await fetch(IMAGES_API, {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(`Uploading the image failed (${res.status})`);
  return ((await res.json()) as { url: string }).url;
}

/** Watches the (same-origin) iframe for SPA navigation and reports the route. */
function RouteWatcher({ onRoute }: { onRoute: (route: string) => void }) {
  const { iframeEl } = useWashiContext();
  useEffect(() => {
    if (!iframeEl) return;
    const tick = setInterval(() => {
      try {
        const loc = iframeEl.contentWindow?.location;
        if (loc?.pathname) onRoute(loc.pathname + loc.search);
      } catch {
        /* not ready yet */
      }
    }, 600);
    return () => clearInterval(tick);
  }, [iframeEl, onRoute]);
  return null;
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
  color: '#fff',
  width: 34,
  height: 34,
  borderRadius: 17,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  fontSize: 15,
  flex: 'none',
} as const;

/** Drag-anywhere bubble: grip, reviewer name, pencil toggle, comment count. */
function Bubble({
  author,
  sidebarOpen,
  onChangeName,
  onToggleSidebar,
}: {
  author: string | null;
  sidebarOpen: boolean;
  onChangeName: () => void;
  onToggleSidebar: () => void;
}) {
  const { mode, setMode, comments, isReady } = useWashiContext();
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
        borderRadius: 22,
        background: 'rgba(23,21,31,.94)',
        boxShadow: '0 10px 30px -12px rgba(20,20,30,.6)',
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
          width: 22,
          height: 34,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(255,255,255,.45)',
          cursor: 'grab',
          fontSize: 13,
          letterSpacing: 1,
          touchAction: 'none',
        }}
      >
        ⋮⋮
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
            color: 'rgba(255,255,255,.85)',
          }}
        >
          {author}
        </button>
      )}
      <button
        type="button"
        title={annotate ? 'Stop commenting' : 'Comment: click anywhere on the page'}
        aria-label={annotate ? 'Exit annotate mode' : 'Enter annotate mode'}
        disabled={!isReady}
        onClick={() => setMode(annotate ? 'view' : 'annotate')}
        style={{
          ...bubbleBtn,
          background: annotate ? ACCENT : 'transparent',
          opacity: isReady ? 1 : 0.4,
        }}
      >
        ✎
      </button>
      <button
        type="button"
        title="Comments on this page"
        aria-label="Toggle comments sidebar"
        onClick={onToggleSidebar}
        style={{ ...bubbleBtn, background: sidebarOpen ? 'rgba(255,255,255,.16)' : 'transparent' }}
      >
        💬
        {comments.length > 0 && (
          <span
            style={{
              position: 'absolute',
              transform: 'translate(11px, -9px)',
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
            {comments.length}
          </span>
        )}
      </button>
    </div>
  );
}

/* ------------------------------------------------------- the create dialog */

/** Popover shown after a pin is placed: text plus pasted or attached images. */
function CreateDialog() {
  const { onPinPlaced, addComment, updateComment, setMode } = useWashiContext();
  const [at, setAt] = useState<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastClick = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const track = (e: PointerEvent) => {
      lastClick.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointerdown', track, true);
    return () => window.removeEventListener('pointerdown', track, true);
  }, []);

  useEffect(
    () =>
      onPinPlaced(({ x, y }) => {
        setAt({ x, y, cx: lastClick.current.x, cy: lastClick.current.y });
        setText('');
        setImages([]);
        setError(null);
      }),
    [onPinPlaced],
  );

  const addFiles = async (files: Iterable<File>) => {
    setError(null);
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      setBusy(true);
      try {
        const url = await uploadImage(f);
        setImages((cur) => [...cur, url]);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Image upload failed');
      } finally {
        setBusy(false);
      }
    }
  };

  const close = () => {
    setAt(null);
    setMode('view');
  };

  const submit = async () => {
    if (!at || (!text.trim() && images.length === 0)) return;
    setBusy(true);
    setError(null);
    try {
      const c = await addComment({ x: at.x, y: at.y, text: text.trim() || '(image)', color: ACCENT });
      if (images.length > 0) {
        await updateComment(c.id, { images } as unknown as Partial<Comment>);
      }
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Saving failed');
    } finally {
      setBusy(false);
    }
  };

  if (!at) return null;
  const left = Math.min(Math.max(at.cx, 12), window.innerWidth - 332);
  const top = Math.min(Math.max(at.cy + 12, 12), window.innerHeight - 300);

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
          onClick={close}
          aria-label="Cancel"
          style={{
            marginLeft: 'auto',
            border: 'none',
            background: 'transparent',
            color: '#8a879a',
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          ✕
        </button>
      </div>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          if (e.clipboardData.files.length > 0) {
            e.preventDefault();
            void addFiles(e.clipboardData.files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === 'Escape') close();
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
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
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
                  fontSize: 10,
                  cursor: 'pointer',
                  lineHeight: 1,
                }}
              >
                ✕
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
          style={{
            border: '1px solid #dcdae6',
            background: '#fff',
            color: '#4a4760',
            borderRadius: 9,
            height: 30,
            padding: '0 11px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          🖼 Add images
        </button>
        <button
          type="button"
          disabled={busy || (!text.trim() && images.length === 0)}
          onClick={() => void submit()}
          style={{
            marginLeft: 'auto',
            border: 'none',
            background: busy || (!text.trim() && images.length === 0) ? '#c9c3dd' : ACCENT,
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
  open,
  focusId,
  onClose,
}: {
  me: string;
  route: string;
  open: boolean;
  focusId: string | null;
  onClose: () => void;
}) {
  const { getCommentIndex, setActivePin } = useWashiContext();
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (open && focusId) cardRefs.current.get(focusId)?.scrollIntoView({ block: 'center' });
  }, [open, focusId]);

  if (!open) return null;
  return (
    <aside
      aria-label="Comments on this page"
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
          padding: '13px 16px',
          borderBottom: '1px solid #eeedf3',
        }}
      >
        <b style={{ fontSize: 13.5, color: '#1b1926' }}>Comments</b>
        <span
          style={{
            fontSize: 11,
            color: '#8a879a',
            fontFamily: 'ui-monospace, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {route}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comments"
          style={{
            marginLeft: 'auto',
            border: 'none',
            background: 'transparent',
            color: '#8a879a',
            fontSize: 15,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px 90px' }}>
        <CommentList
          sort={(a, b) => a.createdAt - b.createdAt}
          emptyState={
            <p style={{ padding: '26px 10px', fontSize: 12.5, color: '#8a879a', textAlign: 'center' }}>
              No comments on this page yet. Use the pencil, then click anywhere.
            </p>
          }
          renderComment={(comment, { onResolve, onDelete }) => {
            const c = comment as ReviewComment;
            const n = getCommentIndex(c.id) + 1;
            return (
              <div
                key={c.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(c.id, el);
                  else cardRefs.current.delete(c.id);
                }}
                onMouseEnter={() => setActivePin(c.id)}
                onMouseLeave={() => setActivePin(null)}
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
                    {n}
                  </span>
                  <b style={{ fontSize: 12.5, color: '#1b1926' }}>{authorOf(c, me)}</b>
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
                  <button type="button" style={sideBtn} onClick={() => void onResolve()}>
                    {c.resolved ? 'Reopen' : 'Resolve'}
                  </button>
                  <button
                    type="button"
                    style={{ ...sideBtn, color: '#b3261e' }}
                    onClick={() => void onDelete()}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          }}
        />
      </div>
    </aside>
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

/**
 * Holds annotate mode behind a name: the pencil bounces back to view and asks
 * once, and a submitted name puts the user straight into annotate mode. The
 * bubble's name chip re-opens the same modal through `forceAsk`.
 */
function NameFlow({
  author,
  forceAsk,
  onNamed,
  onAskHandled,
}: {
  author: string | null;
  forceAsk: boolean;
  onNamed: (name: string) => void;
  onAskHandled: () => void;
}) {
  const { mode, setMode } = useWashiContext();
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (mode === 'annotate' && !author) {
      setMode('view');
      setAsking(true);
    }
  }, [mode, author, setMode]);
  useEffect(() => {
    if (forceAsk) setAsking(true);
  }, [forceAsk]);
  if (!asking) return null;
  const finish = () => {
    setAsking(false);
    onAskHandled();
  };
  return (
    <NameModal
      onCancel={finish}
      onDone={(name) => {
        const hadName = !!author;
        onNamed(name);
        finish();
        if (!hadName) setMode('annotate');
      }}
    />
  );
}

/* --------------------------------------------------------------------- app */

/** The route this page was opened on; /__review itself falls back to the hub. */
function initialRoute(): string {
  const path = location.pathname + location.search;
  if (path === '/' || path.startsWith('/__review')) return '/integrations';
  return path;
}

/** Opens the sidebar when a pin is clicked and remembers which comment. */
function PinClickOpener({ onOpen }: { onOpen: (id: string) => void }) {
  const { onCommentClick } = useWashiContext();
  useEffect(() => onCommentClick((c) => onOpen(c.id)), [onCommentClick, onOpen]);
  return null;
}

export function App() {
  const [author, setAuthor] = useState<string | null>(storedName);
  const [route, setRoute] = useState(initialRoute);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [askName, setAskName] = useState(false);

  // Mirror the iframe's route onto the address bar, so links copied from it
  // open the review at the same page.
  useEffect(() => {
    if (location.pathname + location.search !== route) history.replaceState(null, '', route);
  }, [route]);

  const onRoute = useCallback((r: string) => {
    setRoute((cur) => (r === cur ? cur : r));
  }, []);

  const openAt = useCallback((id: string) => {
    setFocusId(id);
    setSidebarOpen(true);
  }, []);

  const adapter = useMemo(() => new RestAdapter(route), [route]);

  return (
    <WashiProvider key={route} adapter={adapter} mountOptions={{ disableBuiltinDialog: true }}>
      <div style={{ position: 'fixed', inset: 0 }}>
        <WashiFrame
          src={route}
          title="Studio preview"
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
        />
      </div>
      <Bubble
        author={author}
        sidebarOpen={sidebarOpen}
        onChangeName={() => setAskName(true)}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
      />
      <CreateDialog />
      <Sidebar
        me={author ?? 'Anonymous'}
        route={route}
        open={sidebarOpen}
        focusId={focusId}
        onClose={() => {
          setSidebarOpen(false);
          setFocusId(null);
        }}
      />
      <PinClickOpener onOpen={openAt} />
      <RouteWatcher onRoute={onRoute} />
      <NameFlow
        author={author}
        forceAsk={askName}
        onNamed={setAuthor}
        onAskHandled={() => setAskName(false)}
      />
    </WashiProvider>
  );
}
