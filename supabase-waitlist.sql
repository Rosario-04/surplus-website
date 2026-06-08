create table if not exists public.waitlist (
  id uuid primary key,
  name text not null,
  email text not null unique,
  message text not null default '',
  source text not null default 'homepage',
  created_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;

create index if not exists waitlist_created_at_idx
  on public.waitlist (created_at desc);
