/**
 * reviewlution/server: the comments API as a web-standard handler, and the
 * Store contract its backends implement. No framework and no Node-only APIs,
 * so it runs in a Next.js route, a Fastify server or any fetch-style runtime.
 */
export { createReviewHandler } from './handler.js';
export type { ReviewHandler, ReviewHandlerOptions, ReviewRequestHandler } from './handler.js';
export { DEFAULT_BUILD, inBuild } from './store.js';
export type { CommentFilter, DeletedComment, FileKind, RestoreResult, ReviewEvent, Store, StoredFile } from './store.js';
export type { Reply, ReviewComment, Viewport } from '../types.js';
export type { Anchor, AnchorElementInfo } from '../anchors.js';
