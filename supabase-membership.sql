create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null default 'Surplus Member',
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  subscription_status text not null default 'inactive',
  founding_member boolean not null default false,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.member_auth_tokens (
  id uuid primary key,
  member_id uuid not null references public.members(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.member_sessions (
  id uuid primary key,
  member_id uuid not null references public.members(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists members_subscription_status_idx
  on public.members (subscription_status);

create index if not exists member_auth_tokens_member_idx
  on public.member_auth_tokens (member_id, expires_at desc);

create index if not exists member_sessions_member_idx
  on public.member_sessions (member_id, expires_at desc);

alter table public.members enable row level security;
alter table public.member_auth_tokens enable row level security;
alter table public.member_sessions enable row level security;
