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
import type { FileKind, ReviewComment, Store } from './store.js';

export interface ReviewHandlerOptions {
  store: Store;
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

  const handle: ReviewRequestHandler = async (req) => {
    try {
      return await route(req);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'internal error' }, 500);
    }
  };
  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle, handle };
}
