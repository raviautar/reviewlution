/**
 * The reviewlution host. One origin, three jobs:
 *
 *   /__review/           the shell (built by vite) + the comments API
 *   everything else      proxied to the studio preview, so the iframe the
 *                        shell renders is same-origin and the toolbar can read it
 *
 * Comments persist to one JSON file (a volume in the cluster). Access control
 * is the VPN in front of the ingress; there are no accounts anywhere.
 *
 * Hub mode (HUB_APP set) fronts every pull-request preview of one app from a
 * single server: a request to `<app>-pr-<n>-review.<domain>` is proxied to that
 * preview and its comments live under DATA_DIR/<app>-pr-<n>/. With
 * HUB_RECONCILE=1 the hub also keeps the ingresses for those hosts (hub.mjs),
 * so a new pull request gets its review host without anyone deploying it.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import httpProxy from '@fastify/http-proxy';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { previewOfHost, startReconciler } from './hub.mjs';

const PORT = Number(process.env.PORT ?? 8090);
const UPSTREAM = process.env.UPSTREAM ?? 'http://localhost:8099';
const DATA_FILE = process.env.DATA_FILE ?? './comments.json';
// Deleted comments are kept, not dropped, so an accidental delete can be seen
// and restored; capped so the store cannot grow without bound.
const DELETED_CAP = 500;
// Where a visit to `/` (or to /__review itself) lands, and the browser tab title.
const DEFAULT_ROUTE = process.env.DEFAULT_ROUTE ?? '/';
const APP_TITLE = process.env.APP_TITLE ?? 'Preview · reviewlution';
const HUB_APP = process.env.HUB_APP ?? '';
// `{preview}` is `<app>-pr-<n>`, `{n}` the pull request number.
const HUB_UPSTREAM = process.env.HUB_UPSTREAM ?? 'http://{preview}:8080';
const HUB_TITLE = process.env.HUB_TITLE ?? 'Preview';
const DATA_DIR = process.env.DATA_DIR ?? './data';
const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ store */

async function readList(file) {
  try {
    const list = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function openStore(file) {
  const deletedFile = `${file.replace(/\.json$/, '')}.deleted.json`;
  return {
    file,
    deletedFile,
    imageDir: join(dirname(file), 'images'),
    videoDir: join(dirname(file), 'videos'),
    comments: await readList(file),
    deleted: await readList(deletedFile),
    writing: Promise.resolve(),
  };
}

// One store per review host: DATA_FILE for a single app, a folder per preview in
// hub mode. Opened on first use.
const stores = new Map();
function storeOf(req) {
  const key = req.preview;
  if (!stores.has(key)) stores.set(key, openStore(key ? join(DATA_DIR, key, 'comments.json') : DATA_FILE));
  return stores.get(key);
}

function persist(s, op, payload) {
  // A failed write must not wedge every later one behind it.
  s.writing = s.writing
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(s.file), { recursive: true });
      const tmp = `${s.file}.tmp`;
      await writeFile(tmp, JSON.stringify(s.comments, null, 2));
      await rename(tmp, s.file);
      const dtmp = `${s.deletedFile}.tmp`;
      await writeFile(dtmp, JSON.stringify(s.deleted, null, 2));
      await rename(dtmp, s.deletedFile);
      // Append-only journal: every mutation survives here even if the state
      // file is ever clobbered, and any loss can be traced to its request.
      const line = JSON.stringify({ at: new Date().toISOString(), op, payload });
      await appendFile(`${s.file}l`, `${line}\n`);
    });
  return s.writing;
}

/* ----------------------------------------------------------------- server */

const app = Fastify({ logger: true });
app.decorateRequest('preview', '');

if (HUB_APP) {
  app.addHook('onRequest', async (req, reply) => {
    req.preview = previewOfHost(HUB_APP, req.headers.host) ?? '';
    if (req.preview || req.url.startsWith('/__review/healthz')) return;
    reply.code(404).type('text/plain; charset=utf-8').send(`No ${HUB_APP} preview has this host.\n`);
    return reply;
  });
}

// URL transparency: a top-level page navigation to ANY app path gets the shell
// (its assets live under /__review, so it renders from anywhere); the shell
// then iframes the same path, and that load — like every subresource — carries
// a non-document Sec-Fetch-Dest and falls through to the proxy. Requests
// without the header (curl, probes) proxy too.
let shellTemplate = null;
const shells = new Map();
const escapeHtml = (v) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function shellFor(req) {
  if (!shells.has(req.preview)) {
    shellTemplate ??= await readFile(join(here, 'dist', 'index.html'), 'utf8');
    const title = req.preview ? `${HUB_TITLE} PR ${req.preview.split('-pr-').pop()} · Review` : APP_TITLE;
    const config = JSON.stringify({ defaultRoute: DEFAULT_ROUTE, title }).replace(/</g, '\\u003c');
    shells.set(
      req.preview,
      shellTemplate
        .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
        .replace('</head>', `<script>window.__REVIEW_TOOLBAR__=${config}</script></head>`),
    );
  }
  return shells.get(req.preview);
}
app.addHook('onRequest', async (req, reply) => {
  const isDocument = req.headers['sec-fetch-dest'] === 'document';
  if (req.method !== 'GET' || !isDocument) return;
  if (req.url.startsWith('/__review')) return;
  const html = await shellFor(req);
  // A cached shell would keep an old bundle running after a redeploy — the
  // hashed assets may cache forever, the document itself must not.
  reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  return reply;
});

app.addContentTypeParser(
  /^image\//,
  { parseAs: 'buffer', bodyLimit: 15 * 1024 * 1024 },
  (req, body, done) => done(null, body),
);

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGE_TYPE = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

app.post('/__review/api/images', async (req, reply) => {
  const ext = IMAGE_EXT[(req.headers['content-type'] ?? '').split(';')[0]];
  if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    reply.code(415);
    return { error: 'send a png, jpeg, webp or gif body' };
  }
  const s = await storeOf(req);
  const name = `${randomUUID()}.${ext}`;
  await mkdir(s.imageDir, { recursive: true });
  await writeFile(join(s.imageDir, name), req.body);
  reply.code(201);
  return { url: `/__review/api/images/${name}` };
});

app.get('/__review/api/images/:name', async (req, reply) => {
  const m = /^([0-9a-f-]{36})\.(png|jpg|webp|gif)$/.exec(req.params.name);
  if (!m) {
    reply.code(404);
    return { error: 'not found' };
  }
  const s = await storeOf(req);
  try {
    const buf = await readFile(join(s.imageDir, req.params.name));
    reply.type(IMAGE_TYPE[m[2]]).header('cache-control', 'public, max-age=31536000, immutable');
    return buf;
  } catch {
    reply.code(404);
    return { error: 'not found' };
  }
});

// Screen recordings: webm clips of up to 250 MB, stored next to the images and
// streamed back with range support so <video> can seek.
const VIDEO_EXT = { 'video/webm': 'webm', 'video/mp4': 'mp4' };
app.addContentTypeParser(
  /^video\//,
  { parseAs: 'buffer', bodyLimit: 250 * 1024 * 1024 },
  (_req, body, done) => done(null, body),
);
app.post('/__review/api/videos', async (req, reply) => {
  const ext = VIDEO_EXT[(req.headers['content-type'] ?? '').split(';')[0].trim()];
  if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    reply.code(415);
    return { error: 'send a webm or mp4 body' };
  }
  const s = await storeOf(req);
  const name = `${randomUUID()}.${ext}`;
  await mkdir(s.videoDir, { recursive: true });
  await writeFile(join(s.videoDir, name), req.body);
  reply.code(201);
  return { url: `/__review/api/videos/${name}` };
});
app.get('/__review/api/videos/:name', async (req, reply) => {
  if (!/^[0-9a-f-]{36}\.(webm|mp4)$/.test(req.params.name)) {
    reply.code(404);
    return { error: 'not found' };
  }
  const s = await storeOf(req);
  return reply.sendFile(req.params.name, s.videoDir, { maxAge: '365d', immutable: true });
});

let hub = null;
app.get('/__review/healthz', async (req) => {
  if (HUB_APP) return { ok: true, hub: HUB_APP, ...(hub ?? {}) };
  return { ok: true, comments: (await storeOf(req)).comments.length };
});

app.get('/__review/api/comments', async (req) => {
  const { comments } = await storeOf(req);
  const page = req.query.page;
  return page ? comments.filter((c) => c.page === page) : comments;
});

app.post('/__review/api/comments', async (req, reply) => {
  const s = await storeOf(req);
  const c = req.body;
  if (
    !c ||
    typeof c.id !== 'string' ||
    typeof c.text !== 'string' ||
    typeof c.x !== 'number' ||
    typeof c.y !== 'number'
  ) {
    reply.code(400);
    return { error: 'id, text, x and y are required' };
  }
  if (s.comments.some((e) => e.id === c.id)) {
    reply.code(409);
    return { error: 'duplicate id' };
  }
  s.comments.push(c);
  await persist(s, 'create', c);
  reply.code(201);
  return c;
});

app.patch('/__review/api/comments/:id', async (req, reply) => {
  const s = await storeOf(req);
  const i = s.comments.findIndex((c) => c.id === req.params.id);
  if (i < 0) {
    reply.code(404);
    return { error: 'not found' };
  }
  // id is identity. page only changes together with a new anchor — dragging a
  // pin onto another element — never as a side effect of editing the text.
  const { id, page, ...updates } = req.body ?? {};
  if (updates.anchor && typeof page === 'string') updates.page = page;
  s.comments[i] = { ...s.comments[i], ...updates };
  await persist(s, 'update', { id: req.params.id, updates });
  return s.comments[i];
});

// Replies are one level deep and live inside their comment, so a comment and
// its thread travel together everywhere the comment does (list, journal, agents).
app.post('/__review/api/comments/:id/replies', async (req, reply) => {
  const s = await storeOf(req);
  const c = s.comments.find((x) => x.id === req.params.id);
  if (!c) {
    reply.code(404);
    return { error: 'not found' };
  }
  const body = req.body ?? {};
  if (typeof body.text !== 'string' || !body.text.trim()) {
    reply.code(400);
    return { error: 'text is required' };
  }
  const r = {
    id: randomUUID(),
    text: body.text.trim(),
    author: typeof body.author === 'string' ? body.author : undefined,
    createdAt: Date.now(),
  };
  c.replies = [...(c.replies ?? []), r];
  await persist(s, 'reply', { id: c.id, reply: r });
  reply.code(201);
  return c;
});

app.delete('/__review/api/comments/:id/replies/:rid', async (req, reply) => {
  const s = await storeOf(req);
  const c = s.comments.find((x) => x.id === req.params.id);
  const before = c?.replies?.length ?? 0;
  if (!c || !before) {
    reply.code(404);
    return { error: 'not found' };
  }
  c.replies = c.replies.filter((r) => r.id !== req.params.rid);
  if (c.replies.length === before) {
    reply.code(404);
    return { error: 'not found' };
  }
  await persist(s, 'unreply', { id: c.id, rid: req.params.rid });
  reply.code(204);
  return null;
});

app.delete('/__review/api/comments/:id', async (req, reply) => {
  const s = await storeOf(req);
  const before = s.comments.length;
  const removed = s.comments.find((c) => c.id === req.params.id);
  s.comments = s.comments.filter((c) => c.id !== req.params.id);
  if (s.comments.length === before) {
    reply.code(404);
    return { error: 'not found' };
  }
  // Keep it in the deleted store (newest first) so it can be seen and restored.
  s.deleted = [{ ...removed, deletedAt: Date.now() }, ...s.deleted.filter((c) => c.id !== removed.id)].slice(
    0,
    DELETED_CAP,
  );
  await persist(s, 'delete', removed);
  reply.code(204);
  return null;
});

// The deleted store, newest first — the "Deleted" tab and any audit read this.
app.get('/__review/api/deleted', async (req) => (await storeOf(req)).deleted);

// Put a deleted comment back exactly as it was (its pin, thread and media too).
app.post('/__review/api/comments/:id/restore', async (req, reply) => {
  const s = await storeOf(req);
  const i = s.deleted.findIndex((c) => c.id === req.params.id);
  if (i < 0) {
    reply.code(404);
    return { error: 'not found' };
  }
  if (s.comments.some((c) => c.id === req.params.id)) {
    reply.code(409);
    return { error: 'already present' };
  }
  const { deletedAt, ...c } = s.deleted[i];
  s.deleted = s.deleted.filter((x) => x.id !== req.params.id);
  s.comments.push(c);
  await persist(s, 'restore', c);
  reply.code(201);
  return c;
});

app.register(fastifyStatic, {
  root: join(here, 'dist'),
  prefix: '/__review/',
  index: 'index.html',
});

// Everything else is the studio preview, same-origin. Framing headers are
// stripped so the shell may embed any page. In hub mode the upstream is read
// from the host on every request, websocket upgrades included (those arrive
// without the hooks above, so it cannot come from req.preview).
const upstreamOf = (req) => {
  const preview = previewOfHost(HUB_APP, req.headers.host);
  if (!preview) return 'http://review-hub.invalid';
  return HUB_UPSTREAM.replaceAll('{preview}', preview).replaceAll('{n}', preview.split('-pr-').pop());
};
app.register(httpProxy, {
  upstream: HUB_APP ? '' : UPSTREAM,
  prefix: '/',
  // A dev server behind the proxy (Vite, Storybook) keeps hot reload through
  // its websocket; without this the page still works, it just stops updating.
  websocket: true,
  replyOptions: {
    ...(HUB_APP ? { getUpstream: upstreamOf } : {}),
    rewriteHeaders: (headers) => {
      const out = { ...headers };
      delete out['x-frame-options'];
      delete out['content-security-policy'];
      return out;
    },
  },
});

await app.listen({ port: PORT, host: '0.0.0.0' });

if (HUB_APP && process.env.HUB_RECONCILE === '1') {
  hub = startReconciler({
    app: HUB_APP,
    service: process.env.HUB_SERVICE ?? 'review-hub',
    port: PORT,
    intervalMs: Number(process.env.HUB_INTERVAL_MS ?? 30_000),
    log: app.log,
  });
}
