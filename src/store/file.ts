/**
 * reviewlution/store/file: comments in one JSON file, deleted ones in a
 * second (`<name>.deleted.json`), attachments in `images/` and `videos/` next
 * to it, and every mutation appended to `<file>l` (a .jsonl journal), so a
 * clobbered state file can be rebuilt and any loss traced to its request.
 * Writes go one at a time, each to a temp file renamed over the old one.
 */
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { inBuild, type DeletedComment, type FileKind, type ReviewComment, type Store } from '../server/store.js';

export interface FileStoreOptions {
  /** How many deleted comments are kept, newest first. Default 500. */
  deletedCap?: number;
}

async function readList<T>(file: string): Promise<T[]> {
  try {
    const list = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return Array.isArray(list) ? (list as T[]) : [];
  } catch {
    return [];
  }
}

/** A Store on the local disk, rooted at `file` (e.g. `./comments.json`). */
export function fileStore(file: string, { deletedCap = 500 }: FileStoreOptions = {}): Store & { file: string } {
  const deletedFile = `${file.replace(/\.json$/, '')}.deleted.json`;
  const dirOf = (kind: FileKind) => join(dirname(file), kind);
  let state: Promise<{ comments: ReviewComment[]; deleted: DeletedComment[] }> | null = null;
  const load = () =>
    (state ??= Promise.all([readList<ReviewComment>(file), readList<DeletedComment>(deletedFile)]).then(([comments, deleted]) => ({
      comments,
      deleted,
    })));
  let writing: Promise<void> = Promise.resolve();
  // A failed write must not wedge every later one behind it.
  const queue = (job: () => Promise<void>) => (writing = writing.catch(() => {}).then(job));

  const persist = () =>
    queue(async () => {
      const s = await load();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(s.comments, null, 2));
      await rename(`${file}.tmp`, file);
      await writeFile(`${deletedFile}.tmp`, JSON.stringify(s.deleted, null, 2));
      await rename(`${deletedFile}.tmp`, deletedFile);
    });

  return {
    file,

    async list({ page, build }) {
      const { comments } = await load();
      return comments.filter((c) => (!page || c.page === page) && inBuild(c, build));
    },

    async count() {
      return (await load()).comments.length;
    },

    async get(id) {
      return (await load()).comments.find((c) => c.id === id) ?? null;
    },

    async create(c) {
      const s = await load();
      if (s.comments.some((e) => e.id === c.id)) return 'duplicate';
      s.comments.push(c);
      await persist();
      return 'created';
    },

    async update(c) {
      const s = await load();
      const i = s.comments.findIndex((x) => x.id === c.id);
      if (i < 0) return;
      s.comments[i] = c;
      await persist();
    },

    async softDelete(id) {
      const s = await load();
      const removed = s.comments.find((c) => c.id === id);
      if (!removed) return null;
      s.comments = s.comments.filter((c) => c.id !== id);
      s.deleted = [{ ...removed, deletedAt: Date.now() }, ...s.deleted.filter((c) => c.id !== id)].slice(0, deletedCap);
      await persist();
      return removed;
    },

    async listDeleted({ build }) {
      return (await load()).deleted.filter((c) => inBuild(c, build));
    },

    async restore(id) {
      const s = await load();
      const gone = s.deleted.find((c) => c.id === id);
      if (!gone) return { status: 'missing' };
      if (s.comments.some((c) => c.id === id)) return { status: 'present' };
      const { deletedAt: _deletedAt, ...comment } = gone;
      s.deleted = s.deleted.filter((c) => c.id !== id);
      s.comments.push(comment);
      await persist();
      return { status: 'restored', comment };
    },

    async putFile(kind, name, bytes) {
      await mkdir(dirOf(kind), { recursive: true });
      await writeFile(join(dirOf(kind), name), bytes);
    },

    async getFile(kind, name) {
      const path = join(dirOf(kind), name);
      try {
        const { size } = await stat(path);
        return {
          size,
          read: (start, end) => Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>,
        };
      } catch {
        return null;
      }
    },

    journal(op, payload) {
      const line = JSON.stringify({ at: new Date().toISOString(), op, payload });
      return queue(async () => {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(`${file}l`, `${line}\n`);
      });
    },
  };
}
