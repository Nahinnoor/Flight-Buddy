-- travelers: a person on a trip. user_id NULL means unclaimed (§6.2).

create table public.travelers (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.profiles (id) on delete set null,
  display_name text not null,
  invite_email extensions.citext,
  invite_phone text,
  created_by   uuid not null references public.profiles (id),
  claimed_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index travelers_user_id_idx on public.travelers (user_id);
create index travelers_invite_email_idx on public.travelers (invite_email) where user_id is null;
-- FK index, required so profile deletes and created_by lookups stay indexed.
create index travelers_created_by_idx on public.travelers (created_by);

-- A user has exactly one self-traveler.
create unique index travelers_self_traveler_uniq on public.travelers (user_id) where user_id is not null;
