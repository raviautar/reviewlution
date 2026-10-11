/**
 * The reviewlution host. One origin, three jobs:
 *
 *   /__review/           the shell (built by vite) + the comments API
 *   everything else      proxied to the studio preview, so the iframe the
 *                        shell renders is same-origin and the toolbar can read it
 *
 * Comments persist to one JSON file (a volume in the cluster). The API is the
 * package's own handler (src/server, built to dist-lib by `npm run build:lib`)
 * over its file store, adapted to Fastify below: the same code an app mounts
 * when it serves the API itself. Access control is the VPN in front of the
 * ingress; there are no accounts anywhere.
 *
 * Hub mode (HUB_APP set) fronts every pull-request preview of one app from a
 * single server: a request to `<app>-pr-<n>-review.<domain>` is proxied to that
 * preview and its comments live under DATA_DIR/<app>-pr-<n>/. With
 * HUB_RECONCILE=1 the hub also keeps the ingresses for those hosts (hub.mjs),
 * so a new pull request gets its review host without anyone deploying it.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import httpProxy from '@fastify/http-proxy';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { createReviewHandler } from './dist-lib/server/index.js';
import { fileStore } from './dist-lib/store/file.js';
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

// One store and one API handler per review host: DATA_FILE for a single app,
// a folder per preview in hub mode. Opened on first use.
const handlers = new Map();
function handlerOf(req) {
  const key = req.preview;
  if (!handlers.has(key)) {
    const store = fileStore(key ? join(DATA_DIR, key, 'comments.json') : DATA_FILE, { deletedCap: DELETED_CAP });
    handlers.set(key, createReviewHandler({ store, basePath: '/__review/api' }));
  }
  return handlers.get(key);
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

// The comments API: Fastify hands the raw request to the web-standard handler
// and streams its Response back. Bodies stay raw (JSON, images, recordings up
// to 250 MB); the handler parses and checks them.
const toRequest = (req, path = req.url) =>
  new Request(`http://${req.headers.host ?? 'localhost'}${path}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, String(v)]],
    ),
    body: req.method === 'GET' || req.method === 'HEAD' || !req.body?.length ? undefined : req.body,
  });
async function sendResponse(reply, res) {
  reply.code(res.status);
  res.headers.forEach((value, key) => reply.header(key, value));
  return reply.send(res.body ? Readable.fromWeb(res.body) : null);
}
app.register(async (api) => {
  api.removeAllContentTypeParsers();
  api.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 250 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  api.all('/__review/api/*', async (req, reply) => sendResponse(reply, await handlerOf(req).handle(toRequest(req))));
});

let hub = null;
app.get('/__review/healthz', async (req, reply) => {
  if (HUB_APP) return { ok: true, hub: HUB_APP, ...(hub ?? {}) };
  return sendResponse(reply, await handlerOf(req).handle(toRequest(req, '/__review/api/healthz')));
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
