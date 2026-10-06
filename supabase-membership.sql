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

begin;

create table if not exists public.founding_beta_spots (
  spot_number smallint primary key check (spot_number between 1 and 10),
  invited_email text,
  invitation_token_hash text unique,
  invitation_issued_at timestamptz,
  invitation_expires_at timestamptz,
  invitation_revoked_at timestamptz,
  checkout_attempt_id uuid,
  checkout_reservation_token uuid,
  checkout_reservation_expires_at timestamptz,
  stripe_checkout_session_id text unique,
  checkout_session_expires_at timestamptz,
  member_id uuid references public.members(id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  stripe_invoice_id text unique,
  paid_at timestamptz,
  subscription_canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    paid_at is null
    or (
      member_id is not null
      and stripe_customer_id is not null
      and stripe_subscription_id is not null
      and stripe_invoice_id is not null
    )
  )
);

insert into public.founding_beta_spots (spot_number)
select spot_number
from generate_series(1, 10) as spot_number
on conflict (spot_number) do nothing;

do $$
declare
  existing_paid_founding_count integer;
begin
  select count(*) into existing_paid_founding_count
  from public.members
  where founding_member = true
    and first_paid_at is not null;

  if existing_paid_founding_count > 10 then
    raise exception 'Founding Beta migration stopped: more than 10 existing paid founding members require manual reconciliation';
  end if;

  if exists (
    select 1
    from public.members as member
    where member.founding_member = true
      and member.first_paid_at is not null
      and not exists (
        select 1
        from public.stripe_invoices as invoice
        where invoice.member_id = member.id
          and invoice.paid_at is not null
          and invoice.amount_paid >= 3000
          and lower(invoice.currency) = 'usd'
          and invoice.stripe_customer_id is not null
          and invoice.stripe_subscription_id is not null
      )
  ) then
    raise exception 'Founding Beta migration stopped: an existing paid founding member lacks a qualifying persisted Stripe invoice';
  end if;
end;
$$;

with existing_paid_founding as (
  select
    row_number() over (order by member.first_paid_at, member.id)::smallint as spot_number,
    member.id as member_id,
    member.email,
    member.first_paid_at,
    invoice.stripe_customer_id,
    invoice.stripe_subscription_id,
    invoice.stripe_invoice_id
  from public.members as member
  cross join lateral (
    select paid_invoice.*
    from public.stripe_invoices as paid_invoice
    where paid_invoice.member_id = member.id
      and paid_invoice.paid_at is not null
      and paid_invoice.amount_paid >= 3000
      and lower(paid_invoice.currency) = 'usd'
      and paid_invoice.stripe_customer_id is not null
      and paid_invoice.stripe_subscription_id is not null
    order by paid_invoice.paid_at, paid_invoice.stripe_invoice_id
    limit 1
  ) as invoice
  where member.founding_member = true
    and member.first_paid_at is not null
)
update public.founding_beta_spots as spot
set invited_email = existing.email,
    invitation_issued_at = coalesce(spot.invitation_issued_at, existing.first_paid_at),
    member_id = existing.member_id,
    stripe_customer_id = existing.stripe_customer_id,
    stripe_subscription_id = existing.stripe_subscription_id,
    stripe_invoice_id = existing.stripe_invoice_id,
    paid_at = existing.first_paid_at,
    updated_at = clock_timestamp()
from existing_paid_founding as existing
where spot.spot_number = existing.spot_number
  and (
    spot.paid_at is null
    or (
      spot.member_id = existing.member_id
      and spot.stripe_invoice_id = existing.stripe_invoice_id
    )
  );

create unique index if not exists founding_beta_spots_invited_email_idx
  on public.founding_beta_spots (lower(invited_email))
  where invited_email is not null;

create index if not exists founding_beta_spots_paid_at_idx
  on public.founding_beta_spots (paid_at)
  where paid_at is not null;

create or replace function public.reserve_founding_beta_checkout(
  p_invited_email text,
  p_invitation_token_hash text,
  p_reservation_token uuid,
  p_reservation_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  spot public.founding_beta_spots%rowtype;
  server_now timestamptz := clock_timestamp();
  reservation_duration interval := make_interval(secs => greatest(30, least(p_reservation_seconds, 300)));
begin
  select * into spot
  from public.founding_beta_spots
  where invitation_token_hash = p_invitation_token_hash
  for update;

  if not found then
    if (select count(*) from public.founding_beta_spots where paid_at is not null) >= 10 then
      return jsonb_build_object('ok', false, 'status', 'exhausted');
    end if;
    return jsonb_build_object('ok', false, 'status', 'invalid');
  end if;
  if spot.invitation_issued_at is null then
    return jsonb_build_object('ok', false, 'status', 'invalid');
  end if;
  if spot.invitation_revoked_at is not null then
    return jsonb_build_object('ok', false, 'status', 'revoked');
  end if;
  if spot.invitation_expires_at is null or spot.invitation_expires_at <= server_now then
    return jsonb_build_object('ok', false, 'status', 'expired');
  end if;
  if spot.paid_at is not null then
    return jsonb_build_object('ok', false, 'status', 'consumed');
  end if;
  if lower(coalesce(spot.invited_email, '')) <> lower(coalesce(p_invited_email, '')) then
    return jsonb_build_object('ok', false, 'status', 'email_mismatch');
  end if;
  if spot.checkout_reservation_token is not null
     and spot.checkout_reservation_token <> p_reservation_token
     and spot.checkout_reservation_expires_at > server_now then
    return jsonb_build_object('ok', false, 'status', 'busy');
  end if;

  update public.founding_beta_spots
  set checkout_attempt_id = coalesce(checkout_attempt_id, gen_random_uuid()),
      checkout_reservation_token = p_reservation_token,
      checkout_reservation_expires_at = server_now + reservation_duration,
      updated_at = server_now
  where spot_number = spot.spot_number
  returning * into spot;

  return jsonb_build_object(
    'ok', true,
    'status', 'reserved',
    'spot_number', spot.spot_number,
    'checkout_attempt_id', spot.checkout_attempt_id,
    'stripe_checkout_session_id', spot.stripe_checkout_session_id,
    'checkout_session_expires_at', spot.checkout_session_expires_at
  );
end;
$$;

create or replace function public.attach_founding_beta_checkout(
  p_spot_number smallint,
  p_reservation_token uuid,
  p_checkout_attempt_id uuid,
  p_stripe_checkout_session_id text,
  p_checkout_session_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.founding_beta_spots
  set stripe_checkout_session_id = p_stripe_checkout_session_id,
      checkout_session_expires_at = p_checkout_session_expires_at,
      updated_at = clock_timestamp()
  where spot_number = p_spot_number
    and paid_at is null
    and checkout_attempt_id = p_checkout_attempt_id
    and checkout_reservation_token = p_reservation_token
    and checkout_reservation_expires_at > clock_timestamp()
    and (
      stripe_checkout_session_id is null
      or stripe_checkout_session_id = p_stripe_checkout_session_id
    );

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

create or replace function public.rotate_founding_beta_checkout_attempt(
  p_spot_number smallint,
  p_reservation_token uuid,
  p_expected_stripe_checkout_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  next_attempt_id uuid := gen_random_uuid();
  updated_count integer;
begin
  update public.founding_beta_spots
  set checkout_attempt_id = next_attempt_id,
      stripe_checkout_session_id = null,
      checkout_session_expires_at = null,
      updated_at = clock_timestamp()
  where spot_number = p_spot_number
    and paid_at is null
    and checkout_reservation_token = p_reservation_token
    and checkout_reservation_expires_at > clock_timestamp()
    and stripe_checkout_session_id = p_expected_stripe_checkout_session_id;

  get diagnostics updated_count = row_count;
  return jsonb_build_object(
    'ok', updated_count = 1,
    'checkout_attempt_id', case when updated_count = 1 then next_attempt_id else null end
  );
end;
$$;

create or replace function public.release_founding_beta_checkout_reservation(
  p_spot_number smallint,
  p_reservation_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.founding_beta_spots
  set checkout_reservation_token = null,
      checkout_reservation_expires_at = null,
      updated_at = clock_timestamp()
  where spot_number = p_spot_number
    and checkout_reservation_token = p_reservation_token;

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

create or replace function public.claim_founding_beta_spot(
  p_spot_number smallint,
  p_checkout_attempt_id uuid,
  p_stripe_checkout_session_id text,
  p_member_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_invoice_id text,
  p_paid_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  spot public.founding_beta_spots%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('founding-beta-' || p_spot_number::text, 0));

  select * into spot
  from public.founding_beta_spots
  where spot_number = p_spot_number
  for update;

  if not found then
    return false;
  end if;
  if spot.paid_at is not null then
    return spot.checkout_attempt_id = p_checkout_attempt_id
      and spot.stripe_checkout_session_id = p_stripe_checkout_session_id
      and spot.member_id = p_member_id
      and spot.stripe_customer_id = p_stripe_customer_id
      and spot.stripe_subscription_id = p_stripe_subscription_id
      and spot.stripe_invoice_id = p_stripe_invoice_id;
  end if;
  if spot.checkout_attempt_id <> p_checkout_attempt_id
     or spot.stripe_checkout_session_id <> p_stripe_checkout_session_id then
    return false;
  end if;
  if not exists (
    select 1
    from public.members as member
    where member.id = p_member_id
      and lower(member.email) = lower(spot.invited_email)
  ) then
    return false;
  end if;

  update public.founding_beta_spots
  set member_id = p_member_id,
      stripe_customer_id = p_stripe_customer_id,
      stripe_subscription_id = p_stripe_subscription_id,
      stripe_invoice_id = p_stripe_invoice_id,
      paid_at = p_paid_at,
      checkout_reservation_token = null,
      checkout_reservation_expires_at = null,
      updated_at = clock_timestamp()
  where spot_number = p_spot_number;

  update public.members
  set founding_member = true,
      first_paid_at = coalesce(first_paid_at, p_paid_at),
      updated_at = clock_timestamp()
  where id = p_member_id;

  return true;
end;
$$;

create or replace function public.mark_founding_beta_subscription_canceled(
  p_stripe_subscription_id text,
  p_canceled_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.founding_beta_spots
  set subscription_canceled_at = coalesce(subscription_canceled_at, p_canceled_at),
      updated_at = clock_timestamp()
  where stripe_subscription_id = p_stripe_subscription_id
    and paid_at is not null;

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.reserve_founding_beta_checkout(text, text, uuid, integer) from public;
revoke all on function public.reserve_founding_beta_checkout(text, text, uuid, integer) from anon;
revoke all on function public.reserve_founding_beta_checkout(text, text, uuid, integer) from authenticated;
grant execute on function public.reserve_founding_beta_checkout(text, text, uuid, integer) to service_role;

revoke all on function public.attach_founding_beta_checkout(smallint, uuid, uuid, text, timestamptz) from public;
revoke all on function public.attach_founding_beta_checkout(smallint, uuid, uuid, text, timestamptz) from anon;
revoke all on function public.attach_founding_beta_checkout(smallint, uuid, uuid, text, timestamptz) from authenticated;
grant execute on function public.attach_founding_beta_checkout(smallint, uuid, uuid, text, timestamptz) to service_role;

revoke all on function public.rotate_founding_beta_checkout_attempt(smallint, uuid, text) from public;
revoke all on function public.rotate_founding_beta_checkout_attempt(smallint, uuid, text) from anon;
revoke all on function public.rotate_founding_beta_checkout_attempt(smallint, uuid, text) from authenticated;
grant execute on function public.rotate_founding_beta_checkout_attempt(smallint, uuid, text) to service_role;

revoke all on function public.release_founding_beta_checkout_reservation(smallint, uuid) from public;
revoke all on function public.release_founding_beta_checkout_reservation(smallint, uuid) from anon;
revoke all on function public.release_founding_beta_checkout_reservation(smallint, uuid) from authenticated;
grant execute on function public.release_founding_beta_checkout_reservation(smallint, uuid) to service_role;

revoke all on function public.claim_founding_beta_spot(smallint, uuid, text, uuid, text, text, text, timestamptz) from public;
revoke all on function public.claim_founding_beta_spot(smallint, uuid, text, uuid, text, text, text, timestamptz) from anon;
revoke all on function public.claim_founding_beta_spot(smallint, uuid, text, uuid, text, text, text, timestamptz) from authenticated;
grant execute on function public.claim_founding_beta_spot(smallint, uuid, text, uuid, text, text, text, timestamptz) to service_role;

revoke all on function public.mark_founding_beta_subscription_canceled(text, timestamptz) from public;
revoke all on function public.mark_founding_beta_subscription_canceled(text, timestamptz) from anon;
revoke all on function public.mark_founding_beta_subscription_canceled(text, timestamptz) from authenticated;
grant execute on function public.mark_founding_beta_subscription_canceled(text, timestamptz) to service_role;

alter table public.founding_beta_spots enable row level security;

revoke all on table public.founding_beta_spots from public;
revoke all on table public.founding_beta_spots from anon;
revoke all on table public.founding_beta_spots from authenticated;

commit;

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

create table if not exists public.discord_sync_leases (
  member_id uuid primary key references public.members(id) on delete cascade,
  lease_token uuid not null,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop function if exists public.acquire_discord_sync_lease(uuid, uuid, integer);

create function public.acquire_discord_sync_lease(
  p_member_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  lease_duration interval := make_interval(secs => greatest(30, least(p_lease_seconds, 300)));
  lease_expires_at_result timestamptz;
  server_now_result timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));
  server_now_result := clock_timestamp();

  insert into public.discord_sync_leases as lease (
    member_id,
    lease_token,
    lease_expires_at
  ) values (
    p_member_id,
    p_lease_token,
    server_now_result + lease_duration
  )
  on conflict (member_id) do update
  set lease_token = excluded.lease_token,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = server_now_result
  where lease.lease_token = excluded.lease_token
     or lease.lease_expires_at <= server_now_result
  returning lease_expires_at into lease_expires_at_result;

  return jsonb_build_object(
    'ok', lease_expires_at_result is not null,
    'lease_expires_at', lease_expires_at_result,
    'server_now', server_now_result
  );
end;
$$;

drop function if exists public.renew_discord_sync_lease(uuid, uuid, integer);

create function public.renew_discord_sync_lease(
  p_member_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  lease_expires_at_result timestamptz;
  server_now_result timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));
  server_now_result := clock_timestamp();

  update public.discord_sync_leases
  set lease_expires_at = server_now_result + make_interval(secs => greatest(30, least(p_lease_seconds, 300))),
      updated_at = server_now_result
  where member_id = p_member_id
    and lease_token = p_lease_token
  returning lease_expires_at into lease_expires_at_result;

  return jsonb_build_object(
    'ok', lease_expires_at_result is not null,
    'lease_expires_at', lease_expires_at_result,
    'server_now', server_now_result
  );
end;
$$;

create or replace function public.release_discord_sync_lease(
  p_member_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));

  delete from public.discord_sync_leases
  where member_id = p_member_id
    and lease_token = p_lease_token;

  get diagnostics affected_count = row_count;
  return affected_count = 1;
end;
$$;

revoke all on function public.acquire_discord_sync_lease(uuid, uuid, integer) from public;
revoke all on function public.acquire_discord_sync_lease(uuid, uuid, integer) from anon;
revoke all on function public.acquire_discord_sync_lease(uuid, uuid, integer) from authenticated;
grant execute on function public.acquire_discord_sync_lease(uuid, uuid, integer) to service_role;

revoke all on function public.renew_discord_sync_lease(uuid, uuid, integer) from public;
revoke all on function public.renew_discord_sync_lease(uuid, uuid, integer) from anon;
revoke all on function public.renew_discord_sync_lease(uuid, uuid, integer) from authenticated;
grant execute on function public.renew_discord_sync_lease(uuid, uuid, integer) to service_role;

revoke all on function public.release_discord_sync_lease(uuid, uuid) from public;
revoke all on function public.release_discord_sync_lease(uuid, uuid) from anon;
revoke all on function public.release_discord_sync_lease(uuid, uuid) from authenticated;
grant execute on function public.release_discord_sync_lease(uuid, uuid) to service_role;

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

begin;

drop function if exists public.finalize_discord_role_sync(uuid, bigint, text);

create or replace function public.finalize_discord_role_sync(
  p_member_id uuid,
  p_expected_subscription_sync_version bigint,
  p_expected_discord_user_id text,
  p_expected_lease_token uuid
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
    )
    and exists (
      select 1
      from public.discord_sync_leases as lease
      where lease.member_id = p_member_id
        and lease.lease_token = p_expected_lease_token
        and lease.lease_expires_at > clock_timestamp()
    );

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.finalize_discord_role_sync(uuid, bigint, text, uuid) from public;
revoke all on function public.finalize_discord_role_sync(uuid, bigint, text, uuid) from anon;
revoke all on function public.finalize_discord_role_sync(uuid, bigint, text, uuid) from authenticated;
grant execute on function public.finalize_discord_role_sync(uuid, bigint, text, uuid) to service_role;

commit;

alter table public.members enable row level security;
alter table public.member_auth_tokens enable row level security;
alter table public.member_sessions enable row level security;
alter table public.referral_events enable row level security;
alter table public.analytics_events enable row level security;
alter table public.stripe_invoices enable row level security;
alter table public.subscription_lifecycle_events enable row level security;
alter table public.founding_beta_spots enable row level security;
alter table public.discord_role_revocations enable row level security;
alter table public.discord_sync_leases enable row level security;

revoke all on table public.discord_sync_leases from public;
revoke all on table public.discord_sync_leases from anon;
revoke all on table public.discord_sync_leases from authenticated;
