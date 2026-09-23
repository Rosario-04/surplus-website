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
  add column if not exists discord_role_synced_at timestamptz,
  add column if not exists first_paid_at timestamptz,
  add column if not exists recurring_amount integer,
  add column if not exists recurring_interval text,
  add column if not exists subscription_sync_version bigint not null default 0,
  add column if not exists progress_version bigint not null default 0;

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

create table if not exists public.stripe_invoices (
  id uuid primary key default gen_random_uuid(),
  stripe_invoice_id text not null unique,
  member_id uuid references public.members(id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text,
  amount_due integer,
  amount_paid integer,
  currency text,
  billing_reason text,
  invoice_created_at timestamptz,
  paid_at timestamptz,
  last_failed_at timestamptz,
  last_stripe_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stripe_invoices_member_idx
  on public.stripe_invoices (member_id);

create index if not exists stripe_invoices_paid_at_idx
  on public.stripe_invoices (paid_at desc);

create index if not exists stripe_invoices_subscription_idx
  on public.stripe_invoices (stripe_subscription_id)
  where stripe_subscription_id is not null;

create table if not exists public.subscription_lifecycle_events (
  stripe_event_id text primary key,
  member_id uuid references public.members(id) on delete set null,
  stripe_subscription_id text not null,
  event_type text not null check (event_type in ('started', 'canceled')),
  occurred_at timestamptz not null
);

create index if not exists subscription_lifecycle_events_member_idx
  on public.subscription_lifecycle_events (member_id, occurred_at desc);

create index if not exists subscription_lifecycle_events_subscription_idx
  on public.subscription_lifecycle_events (stripe_subscription_id, occurred_at desc);

create table if not exists public.discord_role_revocations (
  member_id uuid not null references public.members(id) on delete cascade,
  discord_user_id text not null,
  obligation_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  last_failed_at timestamptz,
  primary key (member_id, discord_user_id)
);

alter table public.discord_role_revocations
  add column if not exists obligation_token uuid;

update public.discord_role_revocations
set obligation_token = gen_random_uuid()
where obligation_token is null;

alter table public.discord_role_revocations
  alter column obligation_token set default gen_random_uuid(),
  alter column obligation_token set not null;

create index if not exists discord_role_revocations_member_idx
  on public.discord_role_revocations (member_id, created_at);

create or replace function public.clear_discord_sync_marker_for_revocation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.member_id::text, 0));
  update public.members
  set discord_role_synced_at = null,
      updated_at = now()
  where id = new.member_id;
  return new;
end;
$$;

drop trigger if exists discord_role_revocations_clear_sync_marker
  on public.discord_role_revocations;

create trigger discord_role_revocations_clear_sync_marker
after insert or update on public.discord_role_revocations
for each row execute function public.clear_discord_sync_marker_for_revocation();

create or replace function public.finalize_discord_role_sync(
  p_member_id uuid,
  p_expected_subscription_sync_version bigint,
  p_expected_discord_user_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));
  update public.members as member
  set discord_role_synced_at = now(),
      updated_at = now()
  where member.id = p_member_id
    and member.subscription_sync_version = p_expected_subscription_sync_version
    and member.discord_user_id is not distinct from p_expected_discord_user_id
    and not exists (
      select 1
      from public.discord_role_revocations as revocation
      where revocation.member_id = p_member_id
    );

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.finalize_discord_role_sync(uuid, bigint, text) from public;
revoke all on function public.finalize_discord_role_sync(uuid, bigint, text) from anon;
revoke all on function public.finalize_discord_role_sync(uuid, bigint, text) from authenticated;
grant execute on function public.finalize_discord_role_sync(uuid, bigint, text) to service_role;

alter table public.members enable row level security;
alter table public.member_auth_tokens enable row level security;
alter table public.member_sessions enable row level security;
alter table public.referral_events enable row level security;
alter table public.analytics_events enable row level security;
alter table public.stripe_invoices enable row level security;
alter table public.subscription_lifecycle_events enable row level security;
alter table public.discord_role_revocations enable row level security;
