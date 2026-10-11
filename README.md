# reviewlution

A review toolbar for web apps: reviewers pin comments to the elements they are looking at, and agents read and answer the same comments through a small JSON API.

In an app it is three pieces: one install, one route file, one component.

- **`ReviewToolbar`** (`reviewlution`): the React component that draws the toolbar into the app's page.
- **`createReviewHandler`** (`reviewlution/server`): the comments API as one web-standard handler (`Request` in, `Response` out), for a route file.
- **A `Store`** behind it: `reviewlution/store/file` (a JSON file and two folders on disk) or `reviewlution/store/supabase` (a table, a journal table and a storage bucket), or your own.

It also runs without touching the app: [in front of it](#in-front-of-the-app-the-iframe-shell), as a reverse proxy that frames the app and serves the same API from its own disk.

## Quick start (Next.js)

```bash
npm install reviewlution   # react and react-dom 18 or 19 are peers; @supabase/supabase-js too if you use that store
```

The API, in `app/__review/api/[...path]/route.ts` (or any path, with `basePath` set to match):

```ts
import { createReviewHandler } from 'reviewlution/server';
import { fileStore } from 'reviewlution/store/file';

export const { GET, POST, PATCH, DELETE } = createReviewHandler({ store: fileStore('./review/comments.json') });
```

On Vercel or any host without a lasting disk, use Supabase instead: run `sql/supabase.sql` (in the package) once, then

```ts
import { createClient } from '@supabase/supabase-js';
import { createReviewHandler } from 'reviewlution/server';
import { supabaseStore } from 'reviewlution/store/supabase';

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
export const { GET, POST, PATCH, DELETE } = createReviewHandler({ store: supabaseStore(db), maxVideoBytes: 100 * 1024 * 1024 });
```

Folders starting with `_` are private in the App Router, so a route under `/__review` lives in `app/%5F%5Freview/api/[...path]/route.ts`, or anywhere else with a rewrite from `/__review/api/:path*` and both prefixes in `basePath`.

The toolbar, from the root layout or any client component:

```tsx
'use client';
import { ReviewToolbar } from 'reviewlution';
import { usePathname, useRouter } from 'next/navigation';

export function Review() {
  const router = useRouter();
  return <ReviewToolbar route={usePathname()} onNavigate={(p) => router.push(p)} build={process.env.NEXT_PUBLIC_BUILD} />;
}
```

The app decides where it shows (a preview build, a cookie, a signed-in reviewer) and who may call the API (put the route behind your auth, or the network); the component shows wherever it is mounted, and the handler answers whoever reaches it.

## What reviewers get

- Annotate mode (pencil, or ⌥C): hover outlines the element under the cursor in pink with its name; click drops a numbered pin that stays glued to that element through scrolling, layout changes and re-renders.
- Comments with pasted or attached images, area captures (Capture area: drag out part of the page, it is attached as a PNG) and screen recordings (Record screen: drag out the area; while it records the page is live and the toolbar steps aside, a bar at the top shows the clock and "Stop & attach to comment", and the clip lands in the comment you were writing); single-level replies; edit, resolve, reopen, delete; the list refreshes itself every few seconds.
- Pins can be dragged onto another element; a pin shows on its element when that element is on the page (identity is checked, not just position). On a control the size of a button the pin hangs just above it, so the control stays clickable. When the element is gone from the comment's page — a redesigned build, a different tab state — a grey dashed ghost pin marks the original spot instead, the card says "element missing on this build", and every anchored card names the element it points at (e.g. `button · “Test Connection”`).
- Capture area waits a few seconds after you pick the box, keeping the page live, so you can re-open a dropdown a click had closed before the frame is taken (or press Capture now). Images can be pasted into a comment while editing it, not only when first writing it.
- Deleting is a two-press action; deleted comments go to a **Deleted** tab where each can be restored with its pin, thread and images. The server keeps them (`GET /__review/api/deleted`, `POST /__review/api/comments/:id/restore`).
- The comment list (⌥L) covers every page; a card's route chip navigates the app there; cards collapse to one line.

## The component

| Prop | Default | Meaning |
|---|---|---|
| `apiBase` | `/__review/api` | Where the app serves the API. |
| `build` | unset | A tag for this build (`prod`, `pr-12`): sent as `build` on every comment created, and the lists ask for `?build=<tag>`, so each preview keeps its own pins. A comment without a tag counts as `prod`. Unset: no tag, no filter. |
| `author` | unset | The reviewer's name when the app knows it (a signed-in user). Stored as if typed, so the name prompt is skipped; the bubble's name button still changes it. |
| `route` | `location.pathname + location.search`, watched | The page the app is on; comments are filed under it. Pass it from the app's router. |
| `onNavigate` | `location.assign` | How a comment's route chip goes to its page. Pass the router's push. |
| `defaultRoute` | unset | The page a comment saved without one belongs to. |
| `title` | `reviewlution` | Accessible name of the toolbar's region. |

The toolbar draws into the app's own document, above everything else (z-index near the 32-bit maximum), and marks every node it draws with `data-reviewlution` so anchoring, area selection and the phone capture look past it. It renders nothing on the server and appears after mount. The module is marked `'use client'`, so a React Server Components app can render it from a server component. Name, bubble position and drafts are kept in `localStorage` under `reviewlution-*` (older `review-toolbar-*` keys are carried over once).

## The handler

`createReviewHandler(options)` returns `{ GET, POST, PATCH, DELETE, handle }`, each `(request: Request) => Promise<Response>`. It imports no framework and no Node built-ins, so it runs in a Next.js route, a Fastify or Express adapter (see `server.mjs`), or any fetch-style runtime.

| Option | Default | Meaning |
|---|---|---|
| `store` | required | Where comments and files go. |
| `basePath` | `/__review/api` | The prefix the API is served under; the handler reads the path after it. An array when a rewrite makes it reachable under more than one; the first is the public one, used in attachment URLs. |
| `maxVideoBytes` | 250 MB | Largest recording accepted (413 above it). Serverless hosts cap request bodies lower (Vercel: 4.5 MB). |
| `maxImageBytes` | 15 MB | Largest image accepted. |

Attachments are served by the store: a store with `fileUrl` (Supabase's public bucket) gets a 302 there; one with `getFile` is streamed by the handler, with range requests for video seeking.

## Stores

A `Store` (exported as a type from `reviewlution/server`) reads and writes whole comment documents and files; the handler keeps the API's rules. Methods: `list({ page, build })`, `get`, `create` (→ `'created' | 'duplicate'`), `update`, `softDelete`, `listDeleted({ build })`, `restore` (→ `restored | present | missing`), `putFile`, and `fileUrl` or `getFile`; optional `count` and `journal(op, payload)`, an append-only record of every mutation.

- **`fileStore(file, { deletedCap? })`** from `reviewlution/store/file`: comments in `file`, deleted ones in `<name>.deleted.json` (newest 500 kept), images and videos in folders next to it, the journal in `<file>l` (JSON lines). Writes go one at a time, each to a temp file renamed over the old one. One process per file.
- **`supabaseStore(client, { table?, eventsTable?, bucket? })`** from `reviewlution/store/supabase`: one row per comment (`data` jsonb, `deleted_at` for soft deletes), a journal table, a public bucket. Defaults `review_comments`, `review_comment_events`, `review`; the schema is `sql/supabase.sql` (also exported as `reviewlution/sql/supabase.sql`). Pass a service-role client; row level security is on with no policies, so nobody else reads.

## API for agents

All under `/__review/api` (or the app's `basePath`):

- `GET /comments` — every comment (`?page=/path` and `?build=pr-12` filter; untagged comments count as `prod`). A comment carries `text`, `author`, `page`, `anchor` (selector, offsets, element identity), `images`, `resolved`, `replies`.
- `POST /comments` (400 without `id`, `text`, `x`, `y`; 409 on a taken id), `PATCH /comments/:id` (any field; `page` only together with a new `anchor`), `DELETE /comments/:id` (soft: it moves to the deleted list).
- `GET /deleted` (newest first, each with `deletedAt`; takes `?build=`), `POST /comments/:id/restore` (409 when it is already back).
- `POST /comments/:id/replies` `{text, author}`, `DELETE /comments/:id/replies/:rid`.
- `POST /images` (raw image body) → `{url}`; `GET /images/:name`.
- `POST /videos` (raw webm/mp4 body, up to `maxVideoBytes`) → `{url}`; `GET /videos/:name` (range requests supported). Comments list them under `videos`.
- `GET /healthz` → `{ok, comments}`.

The working rule: an agent that fixes what a comment flags PATCHes it `{"resolved": true}` (or replies in-thread); a person can reopen it.

The toolbar uses exactly these routes; an app that serves its own API instead of the handler must answer them with the same payloads and status codes.

Capture and recording use the browser's tab capture (`getDisplayMedia` with the current tab preferred), so they work in Chromium browsers; Safari falls back to whole-window captures.

## In front of the app: the iframe shell

Without changing the app, reviewlution runs as a reverse proxy that shows it in a same-origin iframe and serves the API (the same handler, over the file store) from its own disk.

```
browser ──► reviewlution (:8090) ──► your app (UPSTREAM)
              │  /__review/*   shell assets + comments API (own origin, /data volume)
              └─ everything else is proxied to the app, unchanged
```

A top-level page load of any app path gets the shell; the shell iframes the same path, and in-app navigation is mirrored to the address bar. The app never sees the toolbar's code.

### Run it

```bash
npm ci
npm run build
UPSTREAM=http://localhost:5173 DEFAULT_ROUTE=/ npm start   # http://localhost:8090
```

| Env | Default | Meaning |
|---|---|---|
| `UPSTREAM` | `http://localhost:8099` | The app to review; every non-shell request is proxied here. |
| `PORT` | `8090` | Listen port. |
| `DATA_FILE` | `./comments.json` | Comment store. Images and videos go next to it (`images/`, `videos/`); every mutation is also appended to `<DATA_FILE>l`. |
| `DEFAULT_ROUTE` | `/` | Where a visit to `/` (or to `/__review`) lands in the app. |
| `APP_TITLE` | `Preview · reviewlution` | Browser tab title. |
| `HUB_APP` | unset | Hub mode: front every pull-request preview of this app (see below). `UPSTREAM`, `DATA_FILE` and `APP_TITLE` are then unused. |
| `HUB_UPSTREAM` | `http://{preview}:8080` | Hub mode: where a preview is reached; `{preview}` is `<app>-pr-<n>`, `{n}` the PR number. |
| `HUB_TITLE` | `Preview` | Hub mode: tab title prefix, shown as `<title> PR <n> · Review`. |
| `DATA_DIR` | `./data` | Hub mode: each preview's store is `DATA_DIR/<app>-pr-<n>/comments.json`. |
| `HUB_RECONCILE` | unset | Hub mode: `1` keeps one ingress per live preview (needs the RBAC in `deploy/hub`). |
| `HUB_SERVICE` | `review-hub` | Hub mode: the service those ingresses point at. |
| `HUB_INTERVAL_MS` | `30000` | Hub mode: how often the ingresses are checked. |

The server caches the built `dist/index.html`; after a rebuild, restart it.

### Deploy

`Dockerfile` builds the shell and runs the server. `deploy/base` is a kustomize base (Deployment, Service, PVC for `/data`, Ingress with cert-manager); `deploy/overlays/ih-studio-preview` is the Wand Studio preview on the dev cluster (internal ingress, existing data disk):

```bash
kubectl apply -k deploy/overlays/ih-studio-preview
```

#### Every pull-request preview (hub mode)

`deploy/hub` runs one server for all of wand-studio's PR previews in the `wand-studio` namespace. A request to `wand-studio-pr-<n>-review.dev.wand.ai` is proxied to the `wand-studio-pr-<n>` service, and that PR's comments, images and videos live in their own folder on the hub's disk. Any other host gets a 404.

Nobody deploys anything per PR. Every 30 seconds the hub lists the ingresses ArgoCD made for previews (`wand-studio-pr-<n>`) and keeps a matching `review-hub-pr-<n>` ingress, with the preview's ingress class, certificate issuer and DNS settings. When a PR closes and its preview goes, the review ingress goes too; the comments stay on disk. The hub only changes ingresses it labelled itself (`app.kubernetes.io/managed-by: review-hub`), and it skips a review host that another ingress already serves.

```bash
kubectl apply -k deploy/hub
kubectl -n wand-studio exec deploy/review-hub -- wget -qO- localhost:8090/__review/healthz   # live previews + last run
```

Images are published to `ghcr.io/raviautar/reviewlution:<sha>` on every push to `main` (`.github/workflows/publish.yaml`). Clusters that pull from another registry retag the image there.

## Develop

```bash
npm ci
npm run dev         # the shell, with Vite
npm run build:lib   # the package: dist-lib/ (ES modules and types)
npm test            # builds the package, then the handler, server and hub tests
```
