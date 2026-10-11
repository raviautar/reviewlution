/**
 * reviewlution/store/supabase: comments in a Postgres table, one row per
 * comment holding the document as it is (`data` jsonb, since PATCH may touch
 * any field), soft-deleted with a `deleted_at`; every mutation journalled to
 * an events table; attachments in a public storage bucket, which the API
 * redirects reads to. The schema is sql/supabase.sql in this package. Give it
 * a service-role client: the tables allow nobody else.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_BUILD, type DeletedComment, type ReviewComment, type Store } from '../server/store.js';

export interface SupabaseStoreOptions {
  /** Default `review_comments`. */
  table?: string;
  /** Default `review_comment_events`. */
  eventsTable?: string;
  /** A public bucket. Default `review`. */
  bucket?: string;
}

type Row = { data: ReviewComment; deleted_at?: string | null };

export function supabaseStore(
  client: SupabaseClient,
  { table = 'review_comments', eventsTable = 'review_comment_events', bucket = 'review' }: SupabaseStoreOptions = {},
): Store {
  // Production's rows: tagged with the default build, or from before comments were tagged.
  const defaultRows = `data->>build.is.null,data->>build.eq.${DEFAULT_BUILD}`;

  const get = async (id: string): Promise<ReviewComment | null> => {
    const { data, error } = await client.from(table).select('data').eq('id', id).is('deleted_at', null).maybeSingle();
    if (error) throw new Error(`comment read failed: ${error.message}`);
    return (data as Row | null)?.data ?? null;
  };

  return {
    async list({ page, build }) {
      let q = client.from(table).select('data').is('deleted_at', null).order('created_at', { ascending: true });
      if (page) q = q.eq('data->>page', page);
      if (build === DEFAULT_BUILD) q = q.or(defaultRows);
      else if (build) q = q.eq('data->>build', build);
      const { data, error } = await q;
      if (error) throw new Error(`comments read failed: ${error.message}`);
      return ((data as Row[] | null) ?? []).map((r) => r.data);
    },

    async count() {
      const { count, error } = await client.from(table).select('id', { count: 'exact', head: true }).is('deleted_at', null);
      if (error) throw new Error(`comments count failed: ${error.message}`);
      return count ?? 0;
    },

    get,

    async create(c) {
      const { error } = await client.from(table).insert({ id: c.id, data: c });
      if (!error) return 'created';
      if (error.code === '23505') return 'duplicate';
      throw new Error(`comment insert failed: ${error.message}`);
    },

    async update(c) {
      const { error } = await client.from(table).update({ data: c, updated_at: new Date().toISOString() }).eq('id', c.id);
      if (error) throw new Error(`comment write failed: ${error.message}`);
    },

    async softDelete(id) {
      const c = await get(id);
      if (!c) return null;
      const { error } = await client.from(table).update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) throw new Error(`comment delete failed: ${error.message}`);
      return c;
    },

    async listDeleted({ build }) {
      let q = client.from(table).select('data,deleted_at').not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
      if (build === DEFAULT_BUILD) q = q.or(defaultRows);
      else if (build) q = q.eq('data->>build', build);
      const { data, error } = await q;
      if (error) throw new Error(`deleted read failed: ${error.message}`);
      return ((data as Row[] | null) ?? []).map((r): DeletedComment => ({ ...r.data, deletedAt: Date.parse(r.deleted_at ?? '') || 0 }));
    },

    async restore(id) {
      const { data, error } = await client.from(table).select('data,deleted_at').eq('id', id).maybeSingle();
      if (error) throw new Error(`comment read failed: ${error.message}`);
      const row = data as Row | null;
      if (!row) return { status: 'missing' };
      if (!row.deleted_at) return { status: 'present' };
      const { error: e2 } = await client.from(table).update({ deleted_at: null }).eq('id', id);
      if (e2) throw new Error(`comment restore failed: ${e2.message}`);
      return { status: 'restored', comment: row.data };
    },

    async putFile(kind, name, bytes, contentType) {
      const { error } = await client.storage
        .from(bucket)
        .upload(`${kind}/${name}`, bytes, { contentType, cacheControl: '31536000', upsert: false });
      if (error) throw new Error(`upload failed: ${error.message}`);
    },

    fileUrl(kind, name) {
      return client.storage.from(bucket).getPublicUrl(`${kind}/${name}`).data.publicUrl;
    },

    async journal(op, payload) {
      const { error } = await client.from(eventsTable).insert({ op, payload });
      if (error) throw new Error(`journal failed: ${error.message}`);
    },
  };
}
