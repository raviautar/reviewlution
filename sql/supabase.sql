-- reviewlution on Supabase: the schema reviewlution/store/supabase expects,
-- with its default names (review_comments, review_comment_events,
-- review_events, bucket `review`). Run it once in the SQL editor or as a migration; it is safe to
-- run again.
--
-- One comment per row, kept as the document the toolbar reads and writes; a
-- deleted comment keeps its row with a deleted_at, so it can be restored; an
-- append-only journal of every mutation; a log of error events (the API's
-- 4xx and 5xx, the toolbar's own failures); a public bucket for attachments.

create table if not exists public.review_comments (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.review_comments add column if not exists deleted_at timestamptz;

-- Lists filter on the page and on the build (each preview keeps its own pins).
create index if not exists review_comments_page_idx on public.review_comments ((data->>'page'));
create index if not exists review_comments_build_idx on public.review_comments ((data->>'build'));

create table if not exists public.review_comment_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  op text not null,
  payload jsonb
);

create table if not exists public.review_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  source text not null,
  kind text not null,
  message text not null,
  route text,
  method text,
  status integer,
  stack text,
  url text,
  build text,
  author text,
  viewport jsonb,
  user_agent text,
  context jsonb
);
create index if not exists review_events_at_idx on public.review_events (at desc);

-- The API reads and writes with the service role; nobody else reads at all.
alter table public.review_comments enable row level security;
alter table public.review_comment_events enable row level security;
alter table public.review_events enable row level security;

insert into storage.buckets (id, name, public)
values ('review', 'review', true)
on conflict (id) do nothing;
