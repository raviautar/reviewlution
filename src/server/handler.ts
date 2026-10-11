/**
 * The comments API as one web-standard handler: a `Request` in, a `Response`
 * out, no framework. Mount it wherever the app serves `/__review/api/*` — a
 * Next.js catch-all route file exports its methods, the iframe shell's Fastify
 * server adapts to it — and the toolbar and agents get the same routes,
 * payloads and status codes everywhere (README, "API for agents").
 *
 * The handler reads the API path from the request URL, after `basePath`;
 * several bases can be given when the same handler is reached under more than
 * one prefix (a rewrite). The first is the public one: attachment URLs it
 * hands out start with it.
 */
import type { FileKind, ReviewComment, ReviewEvent, Store } from './store.js';

export interface ReviewHandlerOptions {
  store: Store;
  /**
   * Called with every error event, next to `store.logEvent`: each 4xx or 5xx
   * the API returns, each error it throws, each failure the toolbar reports.
   * Anything it throws is swallowed.
   */
  onEvent?: (event: ReviewEvent) => void | Promise<void>;
  /** The prefix the API is served under. Default `/__review/api`. */
  basePath?: string | string[];
  /** The largest screen recording accepted. Default 250 MB. */
  maxVideoBytes?: number;
  /** The largest image accepted. Default 15 MB. */
  maxImageBytes?: number;
}

export type ReviewRequestHandler = (req: Request) => Promise<Response>;

export interface ReviewHandler {
  GET: ReviewRequestHandler;
  POST: ReviewRequestHandler;
  PATCH: ReviewRequestHandler;
  DELETE: ReviewRequestHandler;
  /** Any method. */
  handle: ReviewRequestHandler;
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGE_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const VIDEO_EXT: Record<string, string> = { 'video/webm': 'webm', 'video/mp4': 'mp4' };
const VIDEO_TYPE: Record<string, string> = { webm: 'video/webm', mp4: 'video/mp4' };
const NAME_RE: Record<FileKind, RegExp> = {
  images: /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/,
  videos: /^[0-9a-f-]{36}\.(webm|mp4)$/,
};
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MB = 1024 * 1024;
/** The largest event the toolbar may report, and how many it may report a minute (per handler). */
const MAX_EVENT_BYTES = 16 * 1024;
const CLIENT_EVENTS_PER_MINUTE = 120;
/** How long a response waits on the event log before it goes anyway. */
const LOG_TIMEOUT_MS = 3000;

const clip = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A failure the toolbar reported, trimmed to the fields and sizes the log keeps; null without a message. */
function clientEvent(body: Record<string, unknown>, req: Request): ReviewEvent | null {
  const message = clip(body.message, 1000);
  if (!message) return null;
  const vp = body.viewport as Record<string, unknown> | null | undefined;
  const w = num(vp?.w);
  const h = num(vp?.h);
  let context: Record<string, unknown> | undefined;
  if (body.context && typeof body.context === 'object' && !Array.isArray(body.context)) {
    const s = JSON.stringify(body.context);
    context = s.length <= 4000 ? (body.context as Record<string, unknown>) : { truncated: s.slice(0, 4000) };
  }
  return {
    at: new Date().toISOString(),
    source: 'client',
    kind: clip(body.kind, 40) ?? 'toolbar',
    message,
    route: clip(body.route, 500),
    url: clip(body.url, 2000),
    build: clip(body.build, 100),
    author: clip(body.author, 200),
    viewport: w !== undefined && h !== undefined ? { w, h, dpr: num(vp?.dpr), device: clip(vp?.device, 100) } : undefined,
    userAgent: clip(body.userAgent, 500) ?? clip(req.headers.get('user-agent'), 500),
    stack: clip(body.stack, 8000),
    context,
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ error: 'not found' }, 404);
const noContent = () => new Response(null, { status: 204 });

/** The single byte range a `Range: bytes=…` header asks for, clamped to the file; null when it cannot be served. */
function byteRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start <= end && start < size ? { start, end } : null;
}

export function createReviewHandler({
  store,
  basePath = '/__review/api',
  maxVideoBytes = 250 * MB,
  maxImageBytes = 15 * MB,
  onEvent,
}: ReviewHandlerOptions): ReviewHandler {
  const bases = (Array.isArray(basePath) ? basePath : [basePath]).map((b) => b.replace(/\/+$/, ''));
  const publicBase = bases[0] ?? '';

  /** The API path after the base (`/comments/abc`), or null when the URL is outside it. */
  const apiPath = (url: URL): string | null => {
    for (const b of bases) {
      if (url.pathname === b) return '/';
      if (url.pathname.startsWith(`${b}/`)) return url.pathname.slice(b.length);
    }
    return null;
  };

  const journal = async (op: string, payload: unknown) => {
    await store.journal?.(op, payload);
  };

  /** Hands an event to the store and to onEvent. Never throws, and never holds a response up for long. */
  const record = async (event: ReviewEvent) => {
    const jobs: Promise<unknown>[] = [];
    for (const sink of [store.logEvent?.bind(store), onEvent]) {
      if (!sink) continue;
      try {
        jobs.push(Promise.resolve(sink(event)).catch(() => {}));
      } catch {
        /* a broken log must not break the API */
      }
    }
    if (!jobs.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(jobs), new Promise((r) => (timer = setTimeout(r, LOG_TIMEOUT_MS)))]);
    clearTimeout(timer);
  };

  // Responses the handler does not log: refusals of a flood of client events.
  const unlogged = new WeakSet<Response>();
  let windowStart = 0;
  let windowCount = 0;
  const clientFlood = () => {
    const now = Date.now();
    if (now - windowStart > 60_000) {
      windowStart = now;
      windowCount = 0;
    }
    return ++windowCount > CLIENT_EVENTS_PER_MINUTE;
  };

  async function postEvent(req: Request): Promise<Response> {
    if (clientFlood()) {
      const res = json({ error: 'too many events' }, 429);
      unlogged.add(res);
      return res;
    }
    const text = await req.text();
    if (text.length > MAX_EVENT_BYTES) return json({ error: `event over ${MAX_EVENT_BYTES / 1024} KB` }, 413);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* answered below */
    }
    const event = body && typeof body === 'object' && !Array.isArray(body) ? clientEvent(body as Record<string, unknown>, req) : null;
    if (!event) return json({ error: 'message is required' }, 400);
    await record(event);
    return noContent();
  }

  async function upload(req: Request, kind: FileKind): Promise<Response> {
    const type = (req.headers.get('content-type') ?? '').split(';')[0].trim();
    const ext = (kind === 'images' ? IMAGE_EXT : VIDEO_EXT)[type];
    const bytes = ext ? new Uint8Array(await req.arrayBuffer()) : null;
    if (!ext || !bytes || bytes.byteLength === 0) {
      return json({ error: kind === 'images' ? 'send a png, jpeg, webp or gif body' : 'send a webm or mp4 body' }, 415);
    }
    const limit = kind === 'images' ? maxImageBytes : maxVideoBytes;
    if (bytes.byteLength > limit) {
      return json({ error: `${kind === 'images' ? 'image' : 'recording'} over ${Math.round(limit / MB)} MB` }, 413);
    }
    const name = `${crypto.randomUUID()}.${ext}`;
    await store.putFile(kind, name, bytes, kind === 'images' ? IMAGE_TYPE[ext] : type);
    return json({ url: `${publicBase}/${kind}/${name}` }, 201);
  }

  async function download(req: Request, kind: FileKind, name: string): Promise<Response> {
    const m = NAME_RE[kind].exec(name);
    if (!m) return notFound();
    if (store.fileUrl) {
      return new Response(null, { status: 302, headers: { location: await store.fileUrl(kind, name) } });
    }
    const file = await store.getFile?.(kind, name);
    if (!file) return notFound();
    const type = (kind === 'images' ? IMAGE_TYPE : VIDEO_TYPE)[m[1]];
    const headers: Record<string, string> = { 'content-type': type, 'cache-control': IMMUTABLE, 'accept-ranges': 'bytes' };
    const range = req.headers.get('range');
    if (range && file.size > 0) {
      const r = byteRange(range, file.size);
      if (!r) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.size}` } });
      return new Response(file.read(r.start, r.end), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${r.start}-${r.end}/${file.size}`, 'content-length': String(r.end - r.start + 1) },
      });
    }
    const body = file.size > 0 ? file.read(0, file.size - 1) : null;
    return new Response(body, { status: 200, headers: { ...headers, 'content-length': String(file.size) } });
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = apiPath(url);
    if (path === null) return notFound();
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method.toUpperCase();
    const [head, id, sub, rid] = parts;

    if (head === 'healthz' && parts.length === 1 && method === 'GET') {
      const count = store.count ? await store.count() : (await store.list({})).length;
      return json({ ok: true, comments: count });
    }

    if (head === 'deleted' && parts.length === 1 && method === 'GET') {
      return json(await store.listDeleted({ build: url.searchParams.get('build') || undefined }));
    }

    if (head === 'events' && parts.length === 1) {
      if (method === 'POST') return postEvent(req);
      if (method === 'GET') {
        if (!store.listEvents) return json({ error: 'this store keeps no events' }, 404);
        const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get('limit'))) || 100, 1), 500);
        return json(await store.listEvents({ limit }));
      }
      return notFound();
    }

    if (head === 'images' || head === 'videos') {
      if (parts.length === 1 && method === 'POST') return upload(req, head);
      if (parts.length === 2 && method === 'GET') return download(req, head, id);
      return notFound();
    }

    if (head !== 'comments') return notFound();

    if (parts.length === 1) {
      if (method === 'GET') {
        return json(
          await store.list({
            page: url.searchParams.get('page') || undefined,
            build: url.searchParams.get('build') || undefined,
          }),
        );
      }
      if (method === 'POST') {
        const c = (await req.json().catch(() => null)) as ReviewComment | null;
        if (!c || typeof c.id !== 'string' || typeof c.text !== 'string' || typeof c.x !== 'number' || typeof c.y !== 'number') {
          return json({ error: 'id, text, x and y are required' }, 400);
        }
        if ((await store.create(c)) === 'duplicate') return json({ error: 'duplicate id' }, 409);
        await journal('create', c);
        return json(c, 201);
      }
      return notFound();
    }

    if (parts.length === 2) {
      if (method === 'PATCH') {
        const existing = await store.get(id);
        if (!existing) return notFound();
        // id is identity. page only changes together with a new anchor — dragging a
        // pin onto another element — never as a side effect of editing the text.
        const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
        const { id: _id, page, ...updates } = body;
        if (updates.anchor && typeof page === 'string') updates.page = page;
        const next = { ...existing, ...updates } as ReviewComment;
        await store.update(next);
        await journal('update', { id, updates });
        return json(next);
      }
      if (method === 'DELETE') {
        const removed = await store.softDelete(id);
        if (!removed) return notFound();
        await journal('delete', removed);
        return noContent();
      }
      return notFound();
    }

    // Replies are one level deep and live inside their comment, so a comment and
    // its thread travel together everywhere the comment does (list, journal, agents).
    if (sub === 'replies' && parts.length === 3 && method === 'POST') {
      const c = await store.get(id);
      if (!c) return notFound();
      const body = ((await req.json().catch(() => null)) ?? {}) as { text?: unknown; author?: unknown };
      if (typeof body.text !== 'string' || !body.text.trim()) return json({ error: 'text is required' }, 400);
      const reply = {
        id: crypto.randomUUID(),
        text: body.text.trim(),
        author: typeof body.author === 'string' ? body.author : undefined,
        createdAt: Date.now(),
      };
      c.replies = [...(c.replies ?? []), reply];
      await store.update(c);
      await journal('reply', { id: c.id, reply });
      return json(c, 201);
    }

    if (sub === 'replies' && parts.length === 4 && method === 'DELETE') {
      const c = await store.get(id);
      const before = c?.replies?.length ?? 0;
      if (!c || !before) return notFound();
      c.replies = (c.replies ?? []).filter((r) => r.id !== rid);
      if (c.replies.length === before) return notFound();
      await store.update(c);
      await journal('unreply', { id: c.id, rid });
      return noContent();
    }

    // Put a deleted comment back exactly as it was (its pin, thread and media too).
    if (sub === 'restore' && parts.length === 3 && method === 'POST') {
      const r = await store.restore(id);
      if (r.status !== 'restored') return r.status === 'missing' ? notFound() : json({ error: 'already present' }, 409);
      await journal('restore', r.comment);
      return json(r.comment, 201);
    }

    return notFound();
  }

  /** A server event for `req`: the API path and query it asked for, how it was answered. */
  const serverEvent = (req: Request, status: number, message: string, stack?: string): ReviewEvent => {
    const url = new URL(req.url);
    return {
      at: new Date().toISOString(),
      source: 'server',
      kind: stack ? 'exception' : 'http',
      message,
      route: `${apiPath(url) ?? url.pathname}${url.search}`.slice(0, 500),
      method: req.method.toUpperCase(),
      status,
      stack: stack?.slice(0, 8000),
      userAgent: clip(req.headers.get('user-agent'), 500),
    };
  };

  // Every 4xx and 5xx is logged with its error message, every thrown error
  // with its stack too, so a reviewer's failed save can be traced afterwards.
  const handle: ReviewRequestHandler = async (req) => {
    let res: Response;
    try {
      res = await route(req);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'internal error';
      await record(serverEvent(req, 500, message, e instanceof Error ? (e.stack ?? message) : String(e)));
      return json({ error: message }, 500);
    }
    if (res.status >= 400 && !unlogged.has(res)) {
      let message = `HTTP ${res.status}`;
      if (/json/.test(res.headers.get('content-type') ?? '')) {
        const body = (await res.clone().json().catch(() => null)) as { error?: unknown } | null;
        if (typeof body?.error === 'string') message = body.error;
      }
      await record(serverEvent(req, res.status, message));
    }
    return res;
  };
  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle, handle };
}
