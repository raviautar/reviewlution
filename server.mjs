/**
 * The review host. One origin, three jobs:
 *
 *   /__review/           the shell (built by vite) + the comments API
 *   everything else      proxied to the studio preview, so the iframe the
 *                        shell renders is same-origin and washi can read it
 *
 * Comments persist to one JSON file (a volume in the cluster). Access control
 * is the VPN in front of the ingress; there are no accounts anywhere.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import httpProxy from '@fastify/http-proxy';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

const PORT = Number(process.env.PORT ?? 8090);
const UPSTREAM = process.env.UPSTREAM ?? 'http://localhost:8099';
const DATA_FILE = process.env.DATA_FILE ?? './comments.json';
// Where a visit to `/` (or to /__review itself) lands, and the browser tab title.
const DEFAULT_ROUTE = process.env.DEFAULT_ROUTE ?? '/';
const APP_TITLE = process.env.APP_TITLE ?? 'Preview · Review';
const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ store */

let comments = [];
try {
  comments = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  if (!Array.isArray(comments)) comments = [];
} catch {
  comments = [];
}

let writing = Promise.resolve();
function persist(op, payload) {
  writing = writing.then(async () => {
    await mkdir(dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(comments, null, 2));
    await rename(tmp, DATA_FILE);
    // Append-only journal: every mutation survives here even if the state
    // file is ever clobbered, and any loss can be traced to its request.
    const line = JSON.stringify({ at: new Date().toISOString(), op, payload });
    await appendFile(`${DATA_FILE}l`, `${line}\n`);
  });
  return writing;
}

/* ----------------------------------------------------------------- server */

const app = Fastify({ logger: true });

// URL transparency: a top-level page navigation to ANY app path gets the shell
// (its assets live under /__review, so it renders from anywhere); the shell
// then iframes the same path, and that load — like every subresource — carries
// a non-document Sec-Fetch-Dest and falls through to the proxy. Requests
// without the header (curl, probes) proxy too.
let shellHtml = null;
const escapeHtml = (v) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function shellWithConfig(html) {
  const config = JSON.stringify({ defaultRoute: DEFAULT_ROUTE, title: APP_TITLE }).replace(/</g, '\\u003c');
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(APP_TITLE)}</title>`)
    .replace('</head>', `<script>window.__WASHI__=${config}</script></head>`);
}
app.addHook('onRequest', async (req, reply) => {
  const isDocument = req.headers['sec-fetch-dest'] === 'document';
  if (req.method !== 'GET' || !isDocument) return;
  if (req.url.startsWith('/__review')) return;
  shellHtml ??= shellWithConfig(await readFile(join(here, 'dist', 'index.html'), 'utf8'));
  // A cached shell would keep an old bundle running after a redeploy — the
  // hashed assets may cache forever, the document itself must not.
  reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(shellHtml);
});

app.addContentTypeParser(
  /^image\//,
  { parseAs: 'buffer', bodyLimit: 15 * 1024 * 1024 },
  (req, body, done) => done(null, body),
);

const IMAGE_DIR = join(dirname(DATA_FILE), 'images');
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGE_TYPE = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

app.post('/__review/api/images', async (req, reply) => {
  const ext = IMAGE_EXT[(req.headers['content-type'] ?? '').split(';')[0]];
  if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    reply.code(415);
    return { error: 'send a png, jpeg, webp or gif body' };
  }
  const name = `${randomUUID()}.${ext}`;
  await mkdir(IMAGE_DIR, { recursive: true });
  await writeFile(join(IMAGE_DIR, name), req.body);
  reply.code(201);
  return { url: `/__review/api/images/${name}` };
});

app.get('/__review/api/images/:name', async (req, reply) => {
  const m = /^([0-9a-f-]{36})\.(png|jpg|webp|gif)$/.exec(req.params.name);
  if (!m) {
    reply.code(404);
    return { error: 'not found' };
  }
  try {
    const buf = await readFile(join(IMAGE_DIR, req.params.name));
    reply.type(IMAGE_TYPE[m[2]]).header('cache-control', 'public, max-age=31536000, immutable');
    return buf;
  } catch {
    reply.code(404);
    return { error: 'not found' };
  }
});

app.get('/__review/healthz', async () => ({ ok: true, comments: comments.length }));

app.get('/__review/api/comments', async (req) => {
  const page = req.query.page;
  return page ? comments.filter((c) => c.page === page) : comments;
});

app.post('/__review/api/comments', async (req, reply) => {
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
  if (comments.some((e) => e.id === c.id)) {
    reply.code(409);
    return { error: 'duplicate id' };
  }
  comments.push(c);
  await persist('create', c);
  reply.code(201);
  return c;
});

app.patch('/__review/api/comments/:id', async (req, reply) => {
  const i = comments.findIndex((c) => c.id === req.params.id);
  if (i < 0) {
    reply.code(404);
    return { error: 'not found' };
  }
  // id is identity. page only changes together with a new anchor — dragging a
  // pin onto another element — never as a side effect of editing the text.
  const { id, page, ...updates } = req.body ?? {};
  if (updates.anchor && typeof page === 'string') updates.page = page;
  comments[i] = { ...comments[i], ...updates };
  await persist('update', { id: req.params.id, updates });
  return comments[i];
});

// Replies are one level deep and live inside their comment, so a comment and
// its thread travel together everywhere the comment does (list, journal, agents).
app.post('/__review/api/comments/:id/replies', async (req, reply) => {
  const c = comments.find((x) => x.id === req.params.id);
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
  await persist('reply', { id: c.id, reply: r });
  reply.code(201);
  return c;
});

app.delete('/__review/api/comments/:id/replies/:rid', async (req, reply) => {
  const c = comments.find((x) => x.id === req.params.id);
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
  await persist('unreply', { id: c.id, rid: req.params.rid });
  reply.code(204);
  return null;
});

app.delete('/__review/api/comments/:id', async (req, reply) => {
  const before = comments.length;
  const removed = comments.find((c) => c.id === req.params.id);
  comments = comments.filter((c) => c.id !== req.params.id);
  if (comments.length === before) {
    reply.code(404);
    return { error: 'not found' };
  }
  await persist('delete', removed);
  reply.code(204);
  return null;
});

app.register(fastifyStatic, {
  root: join(here, 'dist'),
  prefix: '/__review/',
  index: 'index.html',
});

// Everything else is the studio preview, same-origin. Framing headers are
// stripped so the shell may embed any page.
app.register(httpProxy, {
  upstream: UPSTREAM,
  prefix: '/',
  replyOptions: {
    rewriteHeaders: (headers) => {
      const out = { ...headers };
      delete out['x-frame-options'];
      delete out['content-security-policy'];
      return out;
    },
  },
});

await app.listen({ port: PORT, host: '0.0.0.0' });
