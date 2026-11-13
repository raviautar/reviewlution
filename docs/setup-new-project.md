# Set up reviewlution on a new Next.js project on Vercel

This guide adds the review toolbar to a Next.js (App Router) site hosted on Vercel, so that:

- every preview build shows the toolbar, and reviewers pin comments on the page;
- a review subdomain (for example `review.example.com`) serves a `review` branch that always matches `main`, with the toolbar on;
- every preview, the review subdomain included, opens only after a code page, with a code the site owner sets in Vercel;
- production never renders the toolbar, never loads its code, and its comments API answers 404.

It takes about an hour. Every step below is required unless it says "optional".

## What you need

- A Next.js App Router project, deployed by Vercel's Git integration (production from `main`, a preview for every other branch).
- A domain whose DNS you control, for the review subdomain.
- The `reviewlution` package, 0.1.2 or later (for the C shortcut). Until it is on npm, take the tarball from the latest [GitHub release](https://github.com/raviautar/reviewlution/releases) and keep it in your project:

  ```bash
  mkdir -p vendor
  curl -L -o vendor/reviewlution-0.1.2.tgz \
    https://github.com/raviautar/reviewlution/releases/download/v0.1.2/reviewlution-0.1.2.tgz
  npm install file:vendor/reviewlution-0.1.2.tgz @vercel/blob
  ```

  To build one yourself instead: `npm ci && npm pack` in a checkout of the `component` branch. To upgrade, swap the file in `vendor/` and run the install again.

## The files you add

```
lib/review/build.ts            where the toolbar shows, and which build a comment belongs to
lib/review/blob-store.ts       comments in a private Vercel Blob store
lib/review/access.ts           the code check
lib/review/login-page.ts       the code page
proxy.ts                       the code page in front of every preview (middleware.ts before Next 16)
components/review/ReviewShell.tsx
components/review/ReviewToolbar.tsx
app/api/review/[...path]/route.ts
.github/workflows/review-branch.yml
```

Plus a rewrite in `next.config`, one line in the root layout, and `/.review` in `.gitignore`.

## Order of work

1. Steps 1 to 3 and the workflow from step 5, in one push to `main`. Vercel's own login still guards previews, so only your team sees the toolbar.
2. Attach the review subdomain (step 5), then drop a pin on it and on a preview URL while signed in to Vercel (step 6).
3. Step 4, the code page, in a second push. Once it is live on the previews, add the firewall rule and turn Vercel's login off.
4. The site owner sets `REVIEW_CODE` and redeploys the previews.

Splitting it this way lets you check the toolbar before the code exists: you never need to know the code yourself.

## 1. Show the toolbar on previews only

Vercel sets `VERCEL_ENV` to `production`, `preview` or `development`. Everything hangs off it.

`lib/review/build.ts`:

```ts
// Which build this is: each pull request's preview keeps its own comments.
export const PROD_BUILD = "prod"

/** `pr-<n>` on a pull request's preview (the branch name if there is no PR), `prod` everywhere else. */
export function currentBuild(): string {
  if (process.env.VERCEL_ENV !== "preview") return PROD_BUILD
  const pr = process.env.VERCEL_GIT_PULL_REQUEST_ID
  if (pr) return `pr-${pr}`
  return process.env.VERCEL_GIT_COMMIT_REF || "preview"
}

/** The toolbar and its comments API exist on preview builds and in development, never in production. */
export function reviewEnabled(): boolean {
  return process.env.VERCEL_ENV === "preview" || process.env.NODE_ENV === "development"
}
```

`components/review/ReviewToolbar.tsx` loads the toolbar in the browser only, so production visitors never download it:

```tsx
"use client"

import dynamic from "next/dynamic"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

const Toolbar = dynamic(() => import("reviewlution").then((m) => m.ReviewToolbar), { ssr: false })

export function ReviewToolbar({ build }: { build: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams().toString()
  return (
    <Toolbar
      apiBase="/__review/api"
      build={build}
      route={search ? `${pathname}?${search}` : pathname}
      onNavigate={(path) => router.push(path)}
    />
  )
}
```

`components/review/ReviewShell.tsx` is a server component that renders nothing in production:

```tsx
import { Suspense } from "react"
import { currentBuild, reviewEnabled } from "@/lib/review/build"
import { ReviewToolbar } from "./ReviewToolbar"

export function ReviewShell() {
  if (!reviewEnabled()) return null
  return (
    // The toolbar reads the search params; on a static page that suspends.
    <Suspense fallback={null}>
      <ReviewToolbar build={currentBuild()} />
    </Suspense>
  )
}
```

Put `<ReviewShell />` at the end of `<body>` in `app/layout.tsx`. Static pages are rendered at build time with that build's `VERCEL_ENV`, so a production build has no toolbar in its HTML at all.

## 2. The comments API

`app/api/review/[...path]/route.ts` serves the package's handler. It checks the code itself too, so it never depends on the proxy alone:

```ts
import { createReviewHandler, type ReviewHandler } from "reviewlution/server"
import { hasAccess } from "@/lib/review/access"
import { reviewEnabled } from "@/lib/review/build"
import { blobStore } from "@/lib/review/blob-store"

// Built on first request, so the build needs no token.
let handler: ReviewHandler | null = null
async function api(): Promise<ReviewHandler> {
  if (!handler) {
    // Locally without a Blob token, comments go to a git-ignored JSON file.
    const store = process.env.BLOB_READ_WRITE_TOKEN
      ? blobStore()
      : (await import("reviewlution/store/file")).fileStore(".review/comments.json")
    handler = createReviewHandler({
      store,
      basePath: ["/__review/api", "/api/review", "/__review"],
      maxVideoBytes: 100 * 1024 * 1024,
      onEvent: (e) => {
        if (e.kind === "exception") console.error(`review api: ${e.method} ${e.route} → ${e.status}: ${e.message}`, e.stack)
      },
    })
  }
  return handler
}

type Method = "GET" | "POST" | "PATCH" | "DELETE"
const serve = (method: Method) => async (req: Request) => {
  if (!reviewEnabled()) return new Response("Not found", { status: 404 })
  if (!(await hasAccess(req))) return Response.json({ error: "Enter the review code first." }, { status: 401 })
  return (await api())[method](req)
}

export const GET = serve("GET")
export const POST = serve("POST")
export const PATCH = serve("PATCH")
export const DELETE = serve("DELETE")
```

The toolbar calls `/__review/api/*`, and App Router folders that start with `_` are private, so add a rewrite to `next.config`:

```js
async rewrites() {
  return [{ source: "/__review/api/:path*", destination: "/api/review/:path*" }]
},
```

## 3. Store the comments in Vercel Blob

Serverless functions have no disk that lasts, so comments go to a private Vercel Blob store.

1. In Vercel, open Storage and create a Blob store with access **Private**.
2. Connect it to the project for **Preview** and **Development** only, not Production. Vercel adds `BLOB_READ_WRITE_TOKEN` to those environments. Production has no token, so it cannot read or write comments even by mistake.

`lib/review/blob-store.ts` implements the package's `Store` with one JSON file per comment, so two reviewers never overwrite each other:

```ts
// review/comments/<id>.json   live comments
// review/deleted/<id>.json    deleted comments, with deletedAt
// review/files/<kind>/<name>  screenshots and recordings
// review/journal/<time>.json  every change, append-only
// review/events/<time>.json   errors the API or the toolbar reported
import { del, get, list, put } from "@vercel/blob"
import type { DeletedComment, FileKind, ReviewComment, ReviewEvent, Store } from "reviewlution/server"
import { inBuild } from "reviewlution/server"

const ROOT = "review"
const at = (...parts: string[]) => [ROOT, ...parts].join("/")
// Reads skip the CDN cache, so a reviewer sees a comment the moment it is saved.
const READ = { access: "private", useCache: false } as const

async function readJson<T>(pathname: string): Promise<T | null> {
  const res = await get(pathname, READ)
  if (!res || res.statusCode !== 200) return null
  return (await new Response(res.stream).json()) as T
}

function writeJson(pathname: string, value: unknown) {
  return put(pathname, JSON.stringify(value), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  })
}

async function pathnames(prefix: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await list({ prefix, cursor, limit: 1000 })
    out.push(...page.blobs.map((b) => b.pathname))
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
  return out
}

async function readAll<T>(prefix: string): Promise<T[]> {
  const docs = await Promise.all((await pathnames(prefix)).map((p) => readJson<T>(p)))
  return docs.filter((d): d is Awaited<T> & T => d !== null)
}

const stamp = () => `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`

export function blobStore(): Store {
  return {
    async list({ page, build }) {
      const all = await readAll<ReviewComment>(at("comments/"))
      return all.filter((c) => (!page || c.page === page) && inBuild(c, build)).sort((a, b) => a.createdAt - b.createdAt)
    },
    async count() {
      return (await pathnames(at("comments/"))).length
    },
    get(id) {
      return readJson<ReviewComment>(at("comments", `${id}.json`))
    },
    async create(c) {
      if (await readJson(at("comments", `${c.id}.json`))) return "duplicate"
      await writeJson(at("comments", `${c.id}.json`), c)
      return "created"
    },
    async update(c) {
      await writeJson(at("comments", `${c.id}.json`), c)
    },
    async softDelete(id) {
      const c = await readJson<ReviewComment>(at("comments", `${id}.json`))
      if (!c) return null
      await writeJson(at("deleted", `${id}.json`), { ...c, deletedAt: Date.now() })
      await del(at("comments", `${id}.json`))
      return c
    },
    async listDeleted({ build }) {
      const all = await readAll<DeletedComment>(at("deleted/"))
      return all.filter((c) => inBuild(c, build)).sort((a, b) => b.deletedAt - a.deletedAt)
    },
    async restore(id) {
      const gone = await readJson<DeletedComment>(at("deleted", `${id}.json`))
      if (!gone) return { status: "missing" }
      if (await readJson(at("comments", `${id}.json`))) return { status: "present" }
      const { deletedAt: _deletedAt, ...comment } = gone
      await writeJson(at("comments", `${id}.json`), comment)
      await del(at("deleted", `${id}.json`))
      return { status: "restored", comment }
    },
    async putFile(kind, name, bytes, contentType) {
      await put(at("files", kind, name), Buffer.from(bytes), {
        access: "private",
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      })
    },
    async getFile(kind: FileKind, name: string) {
      const pathname = at("files", kind, name)
      const head = await get(pathname, READ)
      if (!head || head.statusCode !== 200) return null
      void head.stream.cancel()
      return {
        size: head.blob.size,
        read: (start: number, end: number) => {
          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
          void get(pathname, { ...READ, headers: { Range: `bytes=${start}-${end}` } }).then((res) =>
            res?.stream ? res.stream.pipeTo(writable) : writable.close(),
          )
          return readable
        },
      }
    },
    async journal(op, payload) {
      await writeJson(at("journal", `${stamp()}.json`), { at: new Date().toISOString(), op, payload })
    },
    async logEvent(event) {
      await writeJson(at("events", `${stamp()}.json`), event)
    },
    async listEvents({ limit }) {
      const names = (await pathnames(at("events/"))).sort().reverse().slice(0, limit)
      const events = await Promise.all(names.map((p) => readJson<ReviewEvent>(p)))
      return events.filter((e): e is ReviewEvent => e !== null).map((e, i) => ({ id: names[i], ...e }))
    },
  }
}
```

Add `/.review` to `.gitignore` for the local file store.

## 4. Lock every preview behind a code

Previews show work that is not public yet, and anyone who opens one can comment. So every preview build, the review subdomain included, shows a code page first. Production never does.

### The code

- The code lives in one Vercel environment variable, `REVIEW_CODE`, target **Preview** only. The site owner sets it in Vercel → the project → Settings → Environment Variables. It never goes in the repo, a chat or a log.
- With no `REVIEW_CODE` set, nobody gets in: the page says the review site is not set up yet.
- A correct code sets an httpOnly cookie for 30 days. Changing the code logs everyone out.
- Optional: `REVIEW_SECRET` (Preview) signs the cookie instead of the code, so you can log everyone out without changing the code.
- Optional: `REVIEW_AGENT_TOKEN` (Preview) lets scripts and agents in with `Authorization: Bearer <token>`, for reading and answering comments (step 7).
- Environment variables reach a deployment when it is built. After setting or changing one, redeploy the previews: push to `main`, or run the review branch workflow by hand.

`lib/review/access.ts`:

```ts
// The gate only runs on preview builds. Fails closed when REVIEW_CODE is missing.
export const ACCESS_COOKIE = "review_access"
export const LOGIN_PATH = "/__review/login"
export const ACCESS_DAYS = 30

export function gated(): boolean {
  return process.env.VERCEL_ENV === "preview"
}

/** Compares in constant time for strings of the same length. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The cookie value a correct code earns, or null when no code is set. */
export async function accessToken(): Promise<string | null> {
  const code = process.env.REVIEW_CODE
  if (!code) return null
  const secret = process.env.REVIEW_SECRET || code
  const bytes = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", bytes.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes.encode(`review:${code}`)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function codeMatches(input: string): boolean {
  const code = process.env.REVIEW_CODE
  return Boolean(code && same(input.trim(), code))
}

function cookie(header: string | null, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=")
    if (k === name) return v.join("=")
  }
  return null
}

/** True outside preview builds, and on a preview for a signed cookie or the agent token. */
export async function hasAccess(req: Request): Promise<boolean> {
  if (!gated()) return true
  const agent = process.env.REVIEW_AGENT_TOKEN
  const auth = req.headers.get("authorization")
  if (agent && auth && same(auth, `Bearer ${agent}`)) return true
  const token = await accessToken()
  const given = cookie(req.headers.get("cookie"), ACCESS_COOKIE)
  return Boolean(token && given && same(given, token))
}
```

`lib/review/login-page.ts` returns one self-contained HTML page, so nothing behind the gate is needed to draw it. A minimal version:

```ts
import { LOGIN_PATH } from "@/lib/review/access"

export type LoginState = "ask" | "wrong" | "closed"

/** Where to go after a correct code: a path on this site, never another host. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/"
  return value.startsWith(LOGIN_PATH) ? "/" : value
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

export function loginPage(next: string, state: LoginState): string {
  const message =
    state === "wrong" ? "That code is not right. Try again." : state === "closed" ? "The review site is not set up yet." : ""
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Review</title></head><body>
<main><h1>Review</h1><p>This version is not public yet. Enter the code to continue.</p>
<form method="post" action="${LOGIN_PATH}">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="code">Code</label>
  <input id="code" name="code" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Open</button>
  <p role="alert">${esc(message)}</p>
</form></main></body></html>`
}
```

Style it like the site, and add a small script that posts the form with `fetch` if you want "wrong code" and "too many tries" (a 429 from the firewall) to show under the field instead of as a new page.

`proxy.ts` (Next 16; on older versions the same code is `middleware.ts` exporting `middleware`):

```ts
import { NextResponse, type NextRequest } from "next/server"
import { ACCESS_COOKIE, ACCESS_DAYS, LOGIN_PATH, accessToken, codeMatches, gated, hasAccess } from "@/lib/review/access"
import { loginPage, safeNext, type LoginState } from "@/lib/review/login-page"

const page = (next: string, state: LoginState, status: number) =>
  new NextResponse(loginPage(next, state), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  })

async function login(req: NextRequest) {
  const form = await req.formData().catch(() => null)
  const next = safeNext(String(form?.get("next") ?? "/"))
  const token = await accessToken()
  if (!token) return page(next, "closed", 503)
  if (!codeMatches(String(form?.get("code") ?? ""))) return page(next, "wrong", 401)
  const res = NextResponse.redirect(new URL(next, req.nextUrl), 303)
  res.headers.set("cache-control", "no-store")
  res.cookies.set(ACCESS_COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: ACCESS_DAYS * 24 * 3600 })
  return res
}

export async function proxy(req: NextRequest) {
  if (!gated()) return NextResponse.next()
  const { pathname, search } = req.nextUrl
  if (pathname === LOGIN_PATH) {
    return req.method === "POST" ? login(req) : page(safeNext(req.nextUrl.searchParams.get("next")), "ask", 200)
  }
  if (await hasAccess(req)) {
    const res = NextResponse.next()
    res.headers.set("x-robots-tag", "noindex")
    return res
  }
  if (pathname.startsWith("/__review/") || pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Enter the review code first." }, { status: 401 })
  }
  return page(pathname + search, "ask", 401)
}

export const config = {
  // Everything but the build's own static files, which hold no page text.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
```

### Limit wrong tries

In Vercel → the project → Firewall, add a custom rule:

- Name: "Review code: tries per IP".
- If: request path equals `/__review/login` **and** method equals `POST`.
- Then: rate limit, fixed window, 10 requests per 600 seconds, keyed on IP; over the limit, deny for 1 hour.

### Let the code replace Vercel's login

Vercel's Deployment Protection (Vercel Authentication) also guards previews, and it does not know your reviewers. Once a build with the code page is live and you have seen the page on a preview, turn it off in Vercel → the project → Settings → Deployment Protection.

Before you do, list the project's preview deployments (Deployments, filtered to Preview). Any built before the code page open without it once Vercel's login is off. Delete them, or close each one with a firewall custom rule: if host equals that deployment's `*.vercel.app` hostname, then deny. Newer previews of the same branch get new hostnames, so the rule never touches them.

Then check from a browser that is not signed in to Vercel: a preview shows the code page, and a closed old deployment answers 403.

## 5. The review branch and subdomain

### Keep `review` in step with `main`

`.github/workflows/review-branch.yml` resets `review` to `main` on every push. Vercel skips a commit it has already deployed, so the branch gets one empty commit of its own on top:

```yaml
name: Review branch follows main

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: review-branch
  cancel-in-progress: true

jobs:
  follow:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          git config user.name "$(git log -1 --format=%an)"
          git config user.email "$(git log -1 --format=%ae)"
          git commit --allow-empty -m "Review build of ${GITHUB_SHA::7}"
          git push --force origin HEAD:refs/heads/review
```

Push it to `main` once, so the `review` branch exists. Nobody commits to `review` by hand: the next push to `main` overwrites it.

### Attach the subdomain

1. Vercel → the project → Settings → Domains → Add `review.example.com`.
2. Choose "Connect to an environment: Preview" and set the Git branch to `review`. Vercel refuses the branch until it exists on GitHub, which is why the workflow goes first.
3. DNS: if the domain uses Vercel's nameservers, there is nothing to do. Otherwise add a `CNAME` for `review` to `cname.vercel-dns.com`.
4. Wait for the certificate (seconds on Vercel DNS), then open `https://review.example.com`: the site with the toolbar, behind Vercel's login until step 4 is live, the code page after.

The same thing through the API is `POST /v10/projects/<project>/domains` with `{"name": "review.example.com", "gitBranch": "review"}`.

## 6. Check it

- **Production:** the page source has no `reviewlution` or `__review` in it, and `https://example.com/__review/api/comments` answers 404.
- **A preview** (open any branch's preview URL, or `review.example.com`): the code page. With no `REVIEW_CODE` set it says the review site is not set up yet; after the owner sets it and the previews are redeployed, the right code opens the site with the toolbar in a corner.
- **A comment:** press **C** (or click the pencil), click an element, write a comment and save it. Reload: the pin is still on that element, and the comment is in the list (⌥L).
- **The shortcut:** C starts commenting and Escape stops. C does nothing while you type in an input, textarea or editable text, or with Cmd, Ctrl or Alt held, so it never fights the app's own fields or copy and paste.
- **Only one toolbar:** turn Vercel's own toolbar off, so reviewers see one comment tool, not two: Vercel → the project → Settings → General → Vercel Toolbar → Preview: Off (the project's `enablePreviewFeedback: false` in the API).
- **Per build:** comments on a pull request's preview are tagged `pr-<n>`; the review branch's comments are tagged `review`.

## 7. How comments get addressed

Comments are work orders. The working rule: whoever fixes what a comment flags ships the fix to `main`, so the review site has it within a few minutes, then replies in the thread with what changed and resolves the comment. The reviewer can reopen it.

The API, under `/__review/api` on the preview (with the code cookie, or `Authorization: Bearer <REVIEW_AGENT_TOKEN>`):

- `GET /comments?build=review` lists the review site's comments; `?page=/path` filters by page. Each has `text`, `author`, `page`, `anchors` (every element the comment is about, in order), `images`, `videos`, `resolved` and `replies`. Read `anchors`, not `anchor`: `anchor` is only the first element. When a comment has no `anchors` (servers before 0.1.3 leave it out on one-element comments), it is about `anchor` alone.
- `POST /comments/:id/replies` with `{"text", "author"}` answers in the thread.
- `PATCH /comments/:id` with `{"resolved": true}` resolves it.
- `GET /images/:name` and `GET /videos/:name` fetch attachments.

To hand comments to an agent:

1. Set `REVIEW_AGENT_TOKEN` as a Preview variable, and give it to the agent the same way as any other secret (an environment secret, never a file in the repo).
2. Give the agent a short procedure in the repo (for example `docs/comment-routine.md`): read the open comments for the `review` build, open each one's page and element, make the change on `main`, wait for the production and review builds to be ready, check the change live, then reply and resolve.
3. Optional: run that procedure on a schedule (daily is enough for most sites), and wake it early when a reviewer writes. The comments API can call the scheduler after a new comment or reply: in the route, after a `POST` that returns 201 without an `Authorization` header, use Next's `after()` to send one request to your scheduler's trigger URL. Debounce it, so a burst of comments makes one run.

Comments live in the Blob store, not in Git, so a redeploy never loses them.
