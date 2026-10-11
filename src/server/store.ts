/**
 * Where comments and their attachments live. The handler (handler.ts) holds
 * the API's rules — validation, status codes, how a reply or a move changes a
 * comment — and asks a Store only to read and write whole comment documents
 * and files, so a new backend is a small adapter: `reviewlution/store/file`
 * (a JSON file and two folders) and `reviewlution/store/supabase` (a table, a
 * journal table and a bucket) ship with the package.
 */
import type { ReviewComment } from '../types.js';

export type { ReviewComment };
export type DeletedComment = ReviewComment & { deletedAt: number };
export type FileKind = 'images' | 'videos';

/** The build an untagged comment belongs to: comments from before builds were tagged count as production's. */
export const DEFAULT_BUILD = 'prod';

export interface CommentFilter {
  /** Only comments left on this page (path plus query). */
  page?: string;
  /** Only comments of this build; untagged ones count as DEFAULT_BUILD. */
  build?: string;
}

/** The bytes of a stored file, read whole or a byte range at a time (for video seeking). */
export interface StoredFile {
  size: number;
  /** `start` and `end` are inclusive byte offsets. */
  read: (start: number, end: number) => ReadableStream<Uint8Array>;
}

export type RestoreResult = { status: 'restored'; comment: ReviewComment } | { status: 'present' | 'missing' };

/**
 * Something that went wrong, kept so it can be debugged later: a 4xx or 5xx
 * the API returned or an error it threw (`source: 'server'`), or a failure the
 * toolbar reported from the browser (`source: 'client'`, POST /events).
 */
export interface ReviewEvent {
  /** Set by the store when it reads events back. */
  id?: string | number;
  /** ISO time; the handler stamps it. */
  at: string;
  source: 'server' | 'client';
  /** `http` (a 4xx or 5xx) and `exception` (thrown) on the server; `fetch`, `upload`, `record`, `capture`, `anchor`, `crash`, `toolbar` from the toolbar. */
  kind: string;
  message: string;
  /** Server: the API path and query. Client: the app route the reviewer was on. */
  route?: string;
  method?: string;
  status?: number;
  /** Server: only for a 5xx. */
  stack?: string;
  /** The page URL the toolbar was on. */
  url?: string;
  build?: string;
  author?: string;
  viewport?: { w: number; h: number; dpr?: number; device?: string };
  userAgent?: string;
  /** A small object of whatever helps (the API call, a selector, a phase). */
  context?: Record<string, unknown>;
}

export interface Store {
  /** Live comments, oldest first. */
  list(filter: CommentFilter): Promise<ReviewComment[]>;
  /** Live comments in all; the healthz count. Falls back to `list({}).length`. */
  count?(): Promise<number>;
  get(id: string): Promise<ReviewComment | null>;
  /** Insert a new comment; `duplicate` when the id is taken. */
  create(c: ReviewComment): Promise<'created' | 'duplicate'>;
  /** Replace a live comment's document. */
  update(c: ReviewComment): Promise<void>;
  /** Move a live comment to the deleted store; returns it, or null when there is none. */
  softDelete(id: string): Promise<ReviewComment | null>;
  /** Deleted comments, newest first, each stamped with when it went. */
  listDeleted(filter: Pick<CommentFilter, 'build'>): Promise<DeletedComment[]>;
  /** Put a deleted comment back exactly as it was. */
  restore(id: string): Promise<RestoreResult>;
  /** Keep an uploaded attachment under `kind/name`. */
  putFile(kind: FileKind, name: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Where an attachment can be fetched; the API redirects there. Set this or `getFile`. */
  fileUrl?(kind: FileKind, name: string): string | Promise<string>;
  /** An attachment's bytes, served by the API itself; null when there is none. */
  getFile?(kind: FileKind, name: string): Promise<StoredFile | null>;
  /** Append-only record of every mutation, called after it is stored. */
  journal?(op: string, payload: unknown): Promise<void>;
  /** Keep an error event. Optional; the handler swallows anything it throws, so logging never breaks the API. */
  logEvent?(event: ReviewEvent): Promise<void>;
  /** The most recent events, newest first (GET /events). */
  listEvents?(opts: { limit: number }): Promise<ReviewEvent[]>;
}

/** Whether `c` belongs to `build`, for stores that filter in memory. */
export function inBuild(c: ReviewComment, build: string | undefined): boolean {
  return !build || (c.build ?? DEFAULT_BUILD) === build;
}
