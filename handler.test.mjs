// The comments API end to end: the handler over the file store, then the same
// routes through server.mjs's Fastify adapter. Runs against dist-lib, which
// `npm test` builds first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createReviewHandler } from './dist-lib/server/index.js';
import { fileStore } from './dist-lib/store/file.js';

const comment = (id, extra = {}) => ({ id, text: `note ${id}`, x: 10, y: 20, createdAt: Date.now(), page: '/a', ...extra });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** Calls an API surface through `send(path, init)`; shared by the handler and the server tests. */
async function walk(send) {
  const call = async (path, init = {}) => {
    const res = await send(path, init);
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? (/json/.test(res.headers.get('content-type') ?? '') ? JSON.parse(text) : text) : null };
  };
  const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await post('/comments', { id: 'x' })).status, 400);
  assert.equal((await post('/comments', comment('c1'))).status, 201);
  assert.equal((await post('/comments', comment('c1'))).status, 409);
  assert.equal((await post('/comments', comment('c2', { build: 'pr-7', page: '/b' }))).status, 201);

  assert.deepEqual((await call('/comments')).body.map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual((await call('/comments?page=/b')).body.map((c) => c.id), ['c2']);
  assert.deepEqual((await call('/comments?build=pr-7')).body.map((c) => c.id), ['c2']);
  // An untagged comment is production's.
  assert.deepEqual((await call('/comments?build=prod')).body.map((c) => c.id), ['c1']);

  // page moves only with a new anchor.
  let r = await call('/comments/c1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'edited', page: '/z', id: 'nope' }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.text, 'edited');
  assert.equal(r.body.page, '/a');
  assert.equal(r.body.id, 'c1');
  const anchor = { selector: 'button', ox: 0.5, oy: 0.5, element: { tag: 'button' } };
  r = await call('/comments/c1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ anchor, page: '/z' }) });
  assert.equal(r.body.page, '/z');
  assert.equal((await call('/comments/missing', { method: 'PATCH', body: '{}' })).status, 404);

  assert.equal((await post('/comments/c1/replies', { text: '  ' })).status, 400);
  assert.equal((await post('/comments/missing/replies', { text: 'hi' })).status, 404);
  r = await post('/comments/c1/replies', { text: ' thanks ', author: 'Ravi' });
  assert.equal(r.status, 201);
  const reply = r.body.replies[0];
  assert.equal(reply.text, 'thanks');
  assert.equal(reply.author, 'Ravi');
  assert.equal((await call(`/comments/c1/replies/nope`, { method: 'DELETE' })).status, 404);
  assert.equal((await call(`/comments/c1/replies/${reply.id}`, { method: 'DELETE' })).status, 204);

  assert.equal((await call('/comments/c2', { method: 'DELETE' })).status, 204);
  assert.equal((await call('/comments/c2', { method: 'DELETE' })).status, 404);
  r = await call('/deleted?build=pr-7');
  assert.deepEqual(r.body.map((c) => c.id), ['c2']);
  assert.equal(typeof r.body[0].deletedAt, 'number');
  assert.deepEqual((await call('/deleted?build=prod')).body, []);
  assert.equal((await post('/comments/c2/restore', {})).status, 201);
  assert.equal((await post('/comments/c2/restore', {})).status, 404);
  assert.equal((await post('/comments/c1/restore', {})).status, 404);

  r = await call('/images', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);
  r = await call('/images', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
  assert.equal(r.status, 201);
  assert.match(r.body.url, /^\/__review\/api\/images\/[0-9a-f-]{36}\.png$/);
  const img = await send(r.body.url.replace('/__review/api', ''), {});
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  assert.equal((await call('/images/../../etc/passwd')).status, 404);

  const clip = Buffer.from('0123456789');
  r = await call('/videos', { method: 'POST', headers: { 'content-type': 'video/webm;codecs=vp9' }, body: clip });
  assert.equal(r.status, 201);
  const path = r.body.url.replace('/__review/api', '');
  const part = await send(path, { headers: { range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '2345');
  const tail = await send(path, { headers: { range: 'bytes=-3' } });
  assert.equal(Buffer.from(await tail.arrayBuffer()).toString(), '789');
  assert.equal((await send(path, { headers: { range: 'bytes=20-' } })).status, 416);

  r = await call('/healthz');
  assert.deepEqual(r.body, { ok: true, comments: 2 });
  assert.equal((await call('/nothing')).status, 404);
}

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reviewlution-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('handler over the file store', async () => {
  const file = join(dir, 'handler', 'comments.json');
  const api = createReviewHandler({ store: fileStore(file) });
  await walk((path, init) => api.handle(new Request(`http://test/__review/api${path}`, init)));
  // State and journal on disk.
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.map((c) => c.id), ['c1', 'c2']);
  const ops = (await readFile(`${file}l`, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).op);
  assert.deepEqual(ops, ['create', 'create', 'update', 'update', 'reply', 'unreply', 'delete', 'restore']);
});

test('a second base path reaches the same API; files are linked under the first', async () => {
  const api = createReviewHandler({ store: fileStore(join(dir, 'bases', 'comments.json')), basePath: ['/__review/api', '/api/review'] });
  const res = await api.POST(new Request('http://test/api/review/images', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG }));
  assert.match((await res.json()).url, /^\/__review\/api\/images\//);
  assert.equal((await api.GET(new Request('http://test/elsewhere/comments'))).status, 404);
});

test('the iframe shell server serves the same API through Fastify', async () => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: String(port), DATA_FILE: join(dir, 'server', 'comments.json'), UPSTREAM: 'http://127.0.0.1:9' },
    stdio: 'ignore',
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${base}/__review/healthz`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await walk((path, init) => fetch(`${base}/__review/api${path}`, init));
    assert.deepEqual(await (await fetch(`${base}/__review/healthz`)).json(), { ok: true, comments: 2 });
  } finally {
    server.kill();
  }
});
