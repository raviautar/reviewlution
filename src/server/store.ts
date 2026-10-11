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
}

/** Whether `c` belongs to `build`, for stores that filter in memory. */
export function inBuild(c: ReviewComment, build: string | undefined): boolean {
  return !build || (c.build ?? DEFAULT_BUILD) === build;
}
