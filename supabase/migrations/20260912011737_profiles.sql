-- profiles: one row per auth.users row (§6.2 identity).

create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  display_name        text not null,
  email               extensions.citext,
  expo_push_token     text,
  quiet_hours_enabled boolean not null default true,
  created_at          timestamptz not null default now()
);

-- Creates the profile row as soon as Supabase Auth creates the user, so the
-- API never has to race the first request against profile creation.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
begin
  v_display_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Traveller'
  );

  insert into public.profiles (id, display_name, email)
  values (new.id, v_display_name, new.email)
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
