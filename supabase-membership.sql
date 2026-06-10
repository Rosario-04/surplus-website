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

alter table public.members
  add column if not exists onboarding jsonb not null default '{}'::jsonb,
  add column if not exists progress jsonb not null default '{}'::jsonb,
  add column if not exists referral_code text,
  add column if not exists referred_by text,
  add column if not exists referral_count integer not null default 0,
  add column if not exists referral_credits integer not null default 0,
  add column if not exists discord_user_id text,
  add column if not exists discord_username text,
  add column if not exists discord_connected_at timestamptz,
  add column if not exists discord_role_synced_at timestamptz;

create unique index if not exists members_discord_user_id_idx
  on public.members (discord_user_id)
  where discord_user_id is not null;

create unique index if not exists members_referral_code_idx
  on public.members (referral_code)
  where referral_code is not null;

create table if not exists public.referral_events (
  id uuid primary key default gen_random_uuid(),
  referrer_member_id uuid not null references public.members(id) on delete cascade,
  referred_member_id uuid not null references public.members(id) on delete cascade,
  referral_code text not null,
  status text not null default 'qualified',
  created_at timestamptz not null default now(),
  unique (referred_member_id)
);

create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references public.members(id) on delete set null,
  event_name text not null,
  page text,
  source text,
  session_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_created_idx
  on public.analytics_events (created_at desc);

create index if not exists analytics_events_name_idx
  on public.analytics_events (event_name, created_at desc);

alter table public.members enable row level security;
alter table public.member_auth_tokens enable row level security;
alter table public.member_sessions enable row level security;
alter table public.referral_events enable row level security;
alter table public.analytics_events enable row level security;
