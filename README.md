# review-toolbar

A review toolbar for web app previews. It sits in front of the app as a reverse proxy, shows the app in a same-origin iframe, and lets reviewers pin comments to the elements they are looking at. Agents read and answer the same comments through a small JSON API.

```
browser ──► review-toolbar (:8090) ──► your app (UPSTREAM)
              │  /__review/*   shell assets + comments API (own origin, /data volume)
              └─ everything else is proxied to the app, unchanged
```

A top-level page load of any app path gets the shell; the shell iframes the same path, and in-app navigation is mirrored to the address bar. The app never sees the toolbar's code.

## What reviewers get

- Annotate mode (pencil, or ⌥C): hover outlines the element under the cursor in pink with its name; click drops a numbered pin that stays glued to that element through scrolling, layout changes and re-renders.
- Comments with pasted or attached images, area captures (Capture area: drag out part of the page, it is attached as a PNG) and screen recordings (Record screen: drag out the area; while it records the page is live and the toolbar steps aside, a bar at the top shows the clock and "Stop & attach to comment", and the clip lands in the comment you were writing); single-level replies; edit, resolve, reopen, delete; the list refreshes itself every few seconds.
- Pins can be dragged onto another element; a pin only shows when its element is actually on the page (identity is checked, not just position).
- The comment list (⌥L) covers every page; a card's route chip navigates the iframe there; cards collapse to one line.

## Run it

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
| `APP_TITLE` | `Preview · Review` | Browser tab title. |

The server caches the built `dist/index.html`; after a rebuild, restart it.

## Deploy

`Dockerfile` builds the shell and runs the server. `deploy/base` is a kustomize base (Deployment, Service, PVC for `/data`, Ingress with cert-manager); `deploy/overlays/ih-studio-preview` is the Wand Studio preview on the dev cluster (internal ingress, existing data disk):

```bash
kubectl apply -k deploy/overlays/ih-studio-preview
```

Images are published to `ghcr.io/raviautar/review-toolbar:<sha>` on every push to `main` (`.github/workflows/publish.yaml`). Clusters that pull from another registry retag the image there.

## API for agents

All under `/__review/api`:

- `GET /comments` — every comment (`?page=/path` filters). A comment carries `text`, `author`, `page`, `anchor` (selector, offsets, element identity), `images`, `resolved`, `replies`.
- `POST /comments`, `PATCH /comments/:id` (any field; `page` only together with a new `anchor`), `DELETE /comments/:id`.
- `POST /comments/:id/replies` `{text, author}`, `DELETE /comments/:id/replies/:rid`.
- `POST /images` (raw image body) → `{url}`; `GET /images/:name`.
- `POST /videos` (raw webm/mp4 body, up to 250 MB) → `{url}`; `GET /videos/:name` (range requests supported). Comments list them under `videos`.
- `GET /healthz`.

The working rule: an agent that fixes what a comment flags PATCHes it `{"resolved": true}` (or replies in-thread); a person can reopen it.

Capture and recording use the browser's tab capture (`getDisplayMedia` with the current tab preferred), so they work in Chromium browsers; Safari falls back to whole-window captures.
